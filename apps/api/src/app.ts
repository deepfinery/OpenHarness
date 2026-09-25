import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { config } from '../../../packages/core/src/config.js';
import { collection, db } from '../../../packages/core/src/db.js';
import { hash, HttpError, passwordHash, safeError } from '../../../packages/core/src/security.js';
import { queueChannel, JOB_QUEUE } from '../../../packages/core/src/queue.js';
import { createRun, requestCancel, terminalStatuses } from '../../../packages/core/src/runs.js';
import { runSchema, type Run } from '../../../packages/core/src/schema.js';
import { finishOAuth } from '../../../packages/core/src/mcp.js';
import {
  clearEmailSettings,
  publicEmailSettings,
  saveEmailSettings,
  sendEmail,
} from '../../../packages/core/src/email.js';
import {
  authenticate,
  checkTokenScope,
  credentialsSchema,
  login,
  logout,
  publicUser,
  rateLimit,
  requireAdmin,
  requireSession,
  setup,
  updateProfile,
  type User,
} from './auth.js';
import { resources } from './resources.js';
import { embedApi, integrations, publicRun, type Embed } from './integrations.js';
import { conversationApi, webhookApi, webhookSettings } from './triggers.js';
import { devices } from './devices.js';
import { tenantView, type Tenant } from './tenant.js';
import { openHarnessApi, openHarnessErrors } from './openharness/index.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin;
  if (
    origin &&
    (req.headers.authorization ||
      (req.method === 'OPTIONS' &&
        req.headers['access-control-request-headers']?.toLowerCase().includes('authorization')))
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (
      origin &&
      origin !== new URL(config.PUBLIC_URL).origin &&
      !req.headers.authorization?.startsWith('Bearer ')
    )
      return next(new HttpError(403, 'Request origin is not allowed'));
    if (req.cookies.agentic_session && !req.headers.authorization?.startsWith('Bearer ') && !origin)
      return next(new HttpError(403, 'A studio session write requires an Origin header'));
    if (
      !req.is('application/json') &&
      !req.is('multipart/form-data') &&
      Number(req.headers['content-length'] ?? 0) > 0
    )
      return next(new HttpError(415, 'Use application/json'));
  }
  next();
});
// The Open Harness API adapter; see apps/api/src/openharness.
app.use(config.OPENHARNESS_BASE_PATH, openHarnessApi(), openHarnessErrors);
app.get('/api/health', async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    await (await queueChannel()).checkQueue(JOB_QUEUE);
    const v = await fetch(`${config.WEAVIATE_URL}/v1/.well-known/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!v.ok) throw new Error('Vector storage unavailable');
    await v.body?.cancel();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'starting' });
  }
});
app.get('/api/auth/status', async (_req, res) => {
  res.json({
    needsSetup: !(await collection<User>('users').findOne({ _id: '00000000-0000-4000-8000-000000000001' })),
    publicUrl: config.PUBLIC_URL,
  });
});
app.post('/api/auth/setup', setup);
app.post('/api/auth/login', login);
app.use('/api/embed', embedApi);
app.use('/api/hooks', webhookApi);
app.use('/api', authenticate);
app.use('/api', conversationApi);
app.get('/api/auth/me', requireSession, (req, res) => res.json(publicUser(req.principal!.user)));
app.post('/api/auth/logout', requireSession, logout);
app.put('/api/profile', requireSession, updateProfile);
app.get('/api/config', requireSession, (_req, res) =>
  res.json({
    publicUrl: config.PUBLIC_URL,
    maxUploadMB: config.MAX_UPLOAD_MB,
    openHarness: { basePath: config.OPENHARNESS_BASE_PATH, harnessId: config.OPENHARNESS_HARNESS_ID },
  }),
);
app.get('/api/tenant', requireSession, async (req, res) =>
  res.json(await tenantView(req.principal!.tenantId)),
);
app.put('/api/tenant', requireAdmin, async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      defaultProviderId: z.string().uuid().nullable().optional(),
    })
    .parse(req.body);
  const tenantId = req.principal!.tenantId;
  if (body.defaultProviderId) {
    const owned = await collection<{ _id: string; ownerId: string }>('providers').findOne({
      _id: body.defaultProviderId,
      ownerId: tenantId,
    });
    if (!owned) throw new HttpError(400, 'Choose a model provider from this workspace');
  }
  const $set: Record<string, unknown> = {};
  if (body.name !== undefined) $set.name = body.name;
  if (body.defaultProviderId !== undefined) $set.defaultProviderId = body.defaultProviderId ?? '';
  await collection<Tenant>('tenants').updateOne({ _id: tenantId }, { $set }, { upsert: true });
  res.json(await tenantView(tenantId));
});
app.get('/api/mcp/oauth/callback', requireSession, async (req, res) => {
  const query = z
    .object({ state: z.string().min(10).max(256), code: z.string().min(1).max(4096) })
    .parse(req.query);
  const connectionId = await finishOAuth(
    query.state,
    query.code,
    req.principal!.tenantId,
    req.principal!.sessionHash!,
  );
  res.redirect(`/connections?authorized=1&connection=${encodeURIComponent(connectionId)}`);
});
app.get('/api/runs', async (req, res) => {
  checkTokenScope(req, 'read');
  const page = z.coerce.number().int().min(0).max(10000).default(0).parse(req.query.page);
  const filter = {
    ownerId: req.principal!.tenantId,
    ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
  };
  const runs = await collection<Run>('runs')
    .find(filter, { projection: { snapshot: 0, outputs: 0, events: 0, history: 0 } })
    .sort({ createdAt: -1 })
    .skip(page * 50)
    .limit(50)
    .toArray();
  res.json(runs.map(publicRun));
});
app.post('/api/runs', async (req, res) => {
  const body = runSchema.parse(req.body);
  checkTokenScope(req, 'execute', body);
  await rateLimit(`run:${req.principal!.tenantId}`, 60);
  const rawKey = req.headers['idempotency-key'];
  const key = rawKey ? z.string().min(1).max(128).parse(rawKey) : undefined;
  const run = await createRun(req.principal!.tenantId, body, {
    ...(key ? { idempotencyKey: key } : {}),
    ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
    initiatedBy: req.principal!.user._id,
    trigger: req.principal!.token ? 'api' : 'studio',
  });
  res.status(202).json(publicRun(run));
});
app.get('/api/runs/:id', async (req, res) => {
  checkTokenScope(req, 'read');
  const run = await collection<Run>('runs').findOne({
    _id: String(req.params.id),
    ownerId: req.principal!.tenantId,
    ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
  });
  if (!run) throw new HttpError(404, 'Run not found');
  checkTokenScope(req, 'read', run);
  res.json(publicRun(run));
});
/** Server-sent events: status, streamed model text and trace events as the runner writes them. */
app.get('/api/runs/:id/stream', async (req, res) => {
  checkTokenScope(req, 'read');
  const filter = {
    _id: String(req.params.id),
    ownerId: req.principal!.tenantId,
    ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
  };
  const runs = collection<Run>('runs');
  const first = await runs.findOne(filter);
  if (!first) throw new HttpError(404, 'Run not found');
  checkTokenScope(req, 'read', first);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let lastKey = '';
  let closed = false;
  const write = (run: Run) => {
    const key = `${run.status}:${run.events.length}:${run.partial?.length ?? 0}:${run.updatedAt?.getTime()}`;
    if (key === lastKey) return;
    lastKey = key;
    res.write(`event: run\ndata: ${JSON.stringify(publicRun(run))}\n\n`);
  };
  const end = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(keepAlive);
    clearTimeout(deadline);
    res.end();
  };
  write(first);
  if (terminalStatuses.includes(first.status)) return end();
  const poll = setInterval(async () => {
    try {
      const run = await runs.findOne(filter);
      if (!run) return end();
      write(run);
      if (terminalStatuses.includes(run.status)) end();
    } catch {
      // Transient database errors: keep the stream open and retry on the next tick.
    }
  }, 400);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  const deadline = setTimeout(end, 35 * 60000);
  req.on('close', end);
});
app.post('/api/runs/:id/cancel', async (req, res) => {
  const filter = {
    _id: String(req.params.id),
    ownerId: req.principal!.tenantId,
    ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
  };
  const run = await collection<Run>('runs').findOne(filter);
  if (!run) throw new HttpError(404, 'Run not found');
  checkTokenScope(req, 'execute', run);
  await requestCancel(filter);
  res.status(202).json({ status: 'cancellation_requested' });
});
app.get('/api/users', requireAdmin, async (_req, res) =>
  res.json(
    (
      await collection<User>('users')
        .find({ tenantId: _req.principal!.tenantId })
        .sort({ createdAt: -1 })
        .toArray()
    ).map(publicUser),
  ),
);
app.post('/api/users', requireAdmin, async (req, res) => {
  const body = credentialsSchema
    .extend({
      name: z.string().min(1).max(100),
      role: z.enum(['admin', 'member']).default('member'),
      workspace: z.enum(['current', 'new']).default('current'),
    })
    .parse(req.body);
  const user: User = {
    _id: randomUUID(),
    tenantId: body.workspace === 'new' ? randomUUID() : req.principal!.tenantId,
    name: body.name,
    email: body.email,
    role: body.workspace === 'new' ? 'admin' : body.role,
    enabled: true,
    createdAt: new Date(),
    passwordHash: await passwordHash(body.password),
  };
  await collection<User>('users').insertOne(user);
  res.status(201).json(publicUser(user));
});
app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const body = z
    .object({ enabled: z.boolean().optional(), newPassword: z.string().min(12).max(256).optional() })
    .parse(req.body);
  if (id === req.principal!.user._id) throw new HttpError(400, 'Use your profile to change your own account');
  const result = await collection<User>('users').updateOne(
    { _id: id, tenantId: req.principal!.tenantId },
    {
      $set: {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.newPassword ? { passwordHash: await passwordHash(body.newPassword) } : {}),
      },
    },
  );
  if (!result.matchedCount) throw new HttpError(404, 'User not found');
  await collection<{ _id: string; userId: string }>('sessions').deleteMany({ userId: id });
  res.status(204).end();
});
app.get('/api/settings/email', requireSession, async (req, res) =>
  res.json(await publicEmailSettings(req.principal!.tenantId)),
);
app.put('/api/settings/email', requireAdmin, async (req, res) =>
  res.json(await saveEmailSettings(req.principal!.tenantId, req.body)),
);
app.delete('/api/settings/email', requireAdmin, async (req, res) => {
  await clearEmailSettings(req.principal!.tenantId);
  res.status(204).end();
});
app.post('/api/settings/email/test', requireAdmin, async (req, res) => {
  const body = z.object({ to: z.string().email().max(320) }).parse(req.body);
  await rateLimit(`email-test:${req.principal!.tenantId}`, 5);
  res.json(
    await sendEmail(req.principal!.tenantId, {
      to: body.to,
      subject: 'OpenHarness test email',
      text: `This message confirms that outgoing email is configured for your workspace.\n\nSent from ${config.PUBLIC_URL}`,
    }),
  );
});
app.use('/api/integrations', requireSession, integrations);
app.use('/api/integrations/webhooks', requireSession, webhookSettings);
app.use('/api/devices', requireSession, devices);
app.use('/api', requireSession, resources);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API endpoint not found')));

const studio = resolve('dist/studio');
app.get('/embed/:id', async (req, res, next) => {
  try {
    const embed = await collection<Embed>('embeds').findOne({
      _id: String(req.params.id),
      expiresAt: { $gt: new Date() },
    });
    if (!embed) return res.status(404).send('Embed link unavailable');
    res.removeHeader('X-Frame-Options');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' ${embed.origins.join(' ')}; object-src 'none'; base-uri 'self'`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(resolve(studio, 'index.html'));
  } catch (e) {
    next(e);
  }
});
app.use(express.static(studio, { index: false, maxAge: '1h' }));
app.get('/{*path}', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(resolve(studio, 'index.html'));
});
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return;
  }
  if ((error as { code?: number }).code === 11000) {
    res.status(409).json({ error: 'This record already exists' });
    return;
  }
  const code = (error as { code?: string }).code;
  const status =
    error instanceof HttpError
      ? error.status
      : code === 'LIMIT_FILE_SIZE'
        ? 413
        : (error as { status?: number }).status === 400
          ? 400
          : 500;
  const message =
    code === 'LIMIT_FILE_SIZE'
      ? `File exceeds the ${config.MAX_UPLOAD_MB} MB upload limit`
      : safeError(error);
  if (status === 500) console.error('Request failed:', message);
  res.status(status).json({ error: message });
});

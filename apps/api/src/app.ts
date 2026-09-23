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
import { createRun } from '../../../packages/core/src/runs.js';
import { runSchema, type Run } from '../../../packages/core/src/schema.js';
import { finishOAuth } from '../../../packages/core/src/mcp.js';
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
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.PUBLIC_URL).origin)
      return next(new HttpError(403, 'Request origin is not allowed'));
    if (req.cookies.agentic_session && !req.headers.authorization && !origin)
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
app.use('/api', authenticate);
app.get('/api/auth/me', requireSession, (req, res) => res.json(publicUser(req.principal!.user)));
app.post('/api/auth/logout', requireSession, logout);
app.put('/api/profile', requireSession, updateProfile);
app.get('/api/config', requireSession, (_req, res) =>
  res.json({ publicUrl: config.PUBLIC_URL, maxUploadMB: config.MAX_UPLOAD_MB }),
);
app.get('/api/mcp/oauth/callback', requireSession, async (req, res) => {
  const query = z
    .object({ state: z.string().min(10).max(256), code: z.string().min(1).max(4096) })
    .parse(req.query);
  await finishOAuth(query.state, query.code, req.principal!.user._id, req.principal!.sessionHash!);
  res.redirect('/connections?authorized=1');
});
app.get('/api/runs', async (req, res) => {
  checkTokenScope(req, 'read');
  const page = z.coerce.number().int().min(0).max(10000).default(0).parse(req.query.page);
  const filter = {
    ownerId: req.principal!.user._id,
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
  await rateLimit(`run:${req.principal!.user._id}`, 60);
  const rawKey = req.headers['idempotency-key'];
  const key = rawKey ? z.string().min(1).max(128).parse(rawKey) : undefined;
  const run = await createRun(req.principal!.user._id, body, {
    ...(key ? { idempotencyKey: key } : {}),
    ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
  });
  res.status(202).json(publicRun(run));
});
app.get('/api/runs/:id', async (req, res) => {
  checkTokenScope(req, 'read');
  const run = await collection<Run>('runs').findOne({
    _id: String(req.params.id),
    ownerId: req.principal!.user._id,
    ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
  });
  if (!run) throw new HttpError(404, 'Run not found');
  checkTokenScope(req, 'read', run);
  res.json(publicRun(run));
});
app.post('/api/runs/:id/cancel', async (req, res) => {
  const filter = {
    _id: String(req.params.id),
    ownerId: req.principal!.user._id,
    ...(req.principal!.token ? { tokenId: req.principal!.token._id } : {}),
  };
  const run = await collection<Run>('runs').findOne(filter);
  if (!run) throw new HttpError(404, 'Run not found');
  checkTokenScope(req, 'execute', run);
  const now = new Date();
  await collection<Run>('runs').updateOne(
    { ...filter, status: 'queued' },
    { $set: { cancelRequested: true, status: 'cancelled', updatedAt: now, finishedAt: now } },
  );
  await collection<Run>('runs').updateOne(
    { ...filter, status: 'running' },
    { $set: { cancelRequested: true, updatedAt: now } },
  );
  res.status(202).json({ status: 'cancellation_requested' });
});
app.get('/api/users', requireAdmin, async (_req, res) =>
  res.json((await collection<User>('users').find().sort({ createdAt: -1 }).toArray()).map(publicUser)),
);
app.post('/api/users', requireAdmin, async (req, res) => {
  const body = credentialsSchema
    .extend({ name: z.string().min(1).max(100), role: z.enum(['admin', 'member']).default('member') })
    .parse(req.body);
  const user: User = {
    _id: randomUUID(),
    name: body.name,
    email: body.email,
    role: body.role,
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
    { _id: id },
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
app.use('/api/integrations', requireSession, integrations);
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

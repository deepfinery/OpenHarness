// HTTP surface: Streamable HTTP MCP per device and for the fleet, the admin API, and health endpoints.
import { clusterSchema, clusterView, type ClusterStore } from './clusters.js';
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { deviceIdPattern, platforms, type Logger } from '@openharness/connector-core';
import { approvalTools, toolTimeouts, type GatewayConfig } from './config.js';
import type { DeviceHub } from './hub.js';
import { DuplicateDeviceError, type Registry } from './registry.js';
import type { GatewayAudit } from './audit.js';
import type { ApprovalProvider } from './approval.js';
import { createDeviceServer } from './deviceServer.js';
import { createFleetServer, deviceView } from './fleet.js';
import { constantEquals, generateDeviceToken, hashDeviceToken, orchestratorAuthenticator } from './tokens.js';

export type HttpDeps = {
  config: GatewayConfig;
  registry: Registry;
  clusters: ClusterStore;
  hub: DeviceHub;
  audit: GatewayAudit;
  approval: ApprovalProvider;
  log: Logger;
};
type McpSession = {
  transport: StreamableHTTPServerTransport;
  target: string;
  identity: string;
  lastUsed: number;
  close: () => Promise<void>;
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

export function createHttpApp(deps: HttpDeps) {
  const { config, registry, clusters, hub, audit, approval, log } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set(
    'trust proxy',
    config.TRUST_PROXY === '1' || config.TRUST_PROXY === 'true' ? 1 : Number(config.TRUST_PROXY) || false,
  );
  app.use(express.json({ limit: '4mb' }));
  const authenticate = orchestratorAuthenticator(config.GATEWAY_API_TOKENS);
  const sessions = new Map<string, McpSession>();
  const timeoutFor = toolTimeouts(config);
  const needApproval = approvalTools(config);
  const publicUrl = config.GATEWAY_PUBLIC_URL;

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get(
    '/readyz',
    wrap(async (_req, res) => {
      await registry.ping();
      res.json({ ok: true, devices_online: hub.statuses().filter((s) => s.online).length });
    }),
  );

  // ---- MCP endpoints -------------------------------------------------------------------------------------------
  const requireOrchestrator = (req: Request, _res: Response, next: NextFunction) => {
    const identity = authenticate(req.headers.authorization);
    if (!identity) return next(new HttpError(401, 'unauthorized'));
    (req as Request & { identity: string }).identity = identity.name;
    next();
  };
  const evict = setInterval(() => {
    const cutoff = Date.now() - config.GATEWAY_HTTP_SESSION_IDLE_SECONDS * 1000;
    for (const [id, s] of sessions) if (s.lastUsed < cutoff) void s.close();
  }, 60_000).unref();

  async function openSession(target: string, identity: string) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, target, identity, lastUsed: Date.now(), close });
      },
    });
    const server =
      target === 'fleet'
        ? createFleetServer({ hub, registry, publicUrl })
        : createDeviceServer(target, identity, {
            hub,
            registry,
            clusters,
            audit,
            approval,
            approvalTools: needApproval,
            timeoutFor,
            log,
          });
    const close = async () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    };
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport;
  }
  const mcpHandler = wrap(async (req, res) => {
    const target = String(req.params.target);
    const identity = (req as Request & { identity: string }).identity;
    if (target !== 'fleet') {
      if (!deviceIdPattern.test(target)) throw new HttpError(404, 'unknown device');
      const record = await registry.get(target);
      if (!record) throw new HttpError(404, 'unknown device');
    }
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId);
      if (!session || session.target !== target) throw new HttpError(404, 'unknown session');
      session.lastUsed = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body))
      throw new HttpError(400, 'send an initialize request first');
    const transport = await openSession(target, identity);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp/:target', requireOrchestrator, mcpHandler);

  // ---- Admin API -----------------------------------------------------------------------------------------------
  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (
      !config.GATEWAY_ADMIN_TOKEN ||
      !header?.startsWith('Bearer ') ||
      !constantEquals(header.slice(7).trim(), config.GATEWAY_ADMIN_TOKEN)
    )
      return next(new HttpError(401, 'unauthorized'));
    next();
  };
  const disconnectCluster = async (id: string) => {
    for (const d of await registry.list()) if (d.cluster_id === id) hub.disconnect(d.device_id);
  };
  app.get(
    '/admin/clusters',
    requireAdmin,
    wrap(async (req, res) => {
      res.json({
        clusters: (
          await clusters.list(typeof req.query.owner === 'string' ? req.query.owner : undefined)
        ).map(clusterView),
      });
    }),
  );
  app.post(
    '/admin/clusters',
    requireAdmin,
    wrap(async (req, res) => {
      const body = clusterSchema.extend({ owner: z.string().min(1).max(200) }).parse(req.body);
      const id = randomUUID(),
        token = `cl_${id}.${generateDeviceToken()}`;
      const cluster = {
        ...body,
        _id: id,
        token_hash: await hashDeviceToken(token),
        created_at: new Date().toISOString(),
        slots: [],
      };
      await clusters.create(cluster);
      res.status(201).json({ cluster: clusterView(cluster), token });
    }),
  );
  app.put(
    '/admin/clusters/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (!(await clusters.get(id))) throw new HttpError(404, 'unknown cluster');
      const patch = clusterSchema.partial().parse(req.body);
      await clusters.update(id, patch);
      if (patch.disabled) await disconnectCluster(id);
      res.json({ cluster: clusterView((await clusters.get(id))!) });
    }),
  );
  app.post(
    '/admin/clusters/:id/rotate-token',
    requireAdmin,
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (!(await clusters.get(id))) throw new HttpError(404, 'unknown cluster');
      const token = `cl_${id}.${generateDeviceToken()}`;
      await clusters.update(id, { token_hash: await hashDeviceToken(token) });
      await disconnectCluster(id);
      res.json({ token });
    }),
  );
  const enrollBody = z.object({
    device_id: z.string().regex(deviceIdPattern),
    name: z.string().trim().max(100).default(''),
    platform: z.enum(platforms),
    owner: z.string().max(200).default(''),
    allowed_tools: z.array(z.string().min(1).max(200)).max(200).default([]),
  });
  app.get(
    '/admin/devices',
    requireAdmin,
    wrap(async (req, res) => {
      const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined;
      res.json({
        devices: (await registry.list(owner)).map((r) => deviceView(r, hub, publicUrl)),
        public_url: publicUrl,
      });
    }),
  );
  app.post(
    '/admin/devices',
    requireAdmin,
    wrap(async (req, res) => {
      const body = enrollBody.parse(req.body);
      if (await registry.get(body.device_id)) throw new HttpError(409, 'device id already exists');
      const token = generateDeviceToken();
      await registry.create({
        ...body,
        token_hash: await hashDeviceToken(token),
        created_at: new Date().toISOString(),
        disabled: false,
      });
      log.info('device enrolled', { device_id: body.device_id, platform: body.platform, owner: body.owner });
      res.status(201).json({
        device: deviceView((await registry.get(body.device_id))!, hub, publicUrl),
        token,
        connect_url: `${publicUrl.replace(/\/$/, '')}/connect`,
      });
    }),
  );
  app.put(
    '/admin/devices/:id',
    requireAdmin,
    wrap(async (req, res) => {
      const patch = z
        .object({
          name: z.string().trim().max(100).optional(),
          allowed_tools: z.array(z.string().min(1).max(200)).max(200).optional(),
          disabled: z.boolean().optional(),
        })
        .parse(req.body);
      if (!(await registry.update(String(req.params.id), patch))) throw new HttpError(404, 'unknown device');
      if (patch.disabled) hub.disconnect(String(req.params.id));
      res.json({ device: deviceView((await registry.get(String(req.params.id)))!, hub, publicUrl) });
    }),
  );
  app.post(
    '/admin/devices/:id/rotate-token',
    requireAdmin,
    wrap(async (req, res) => {
      if ((await registry.get(String(req.params.id)))?.cluster_id)
        throw new HttpError(409, 'Rotate the cluster token for this node');
      const token = generateDeviceToken();
      if (!(await registry.update(String(req.params.id), { token_hash: await hashDeviceToken(token) })))
        throw new HttpError(404, 'unknown device');
      hub.disconnect(String(req.params.id));
      res.json({ token, connect_url: `${publicUrl.replace(/\/$/, '')}/connect` });
    }),
  );
  app.delete(
    '/admin/devices/:id',
    requireAdmin,
    wrap(async (req, res) => {
      hub.disconnect(String(req.params.id));
      if (!(await registry.delete(String(req.params.id)))) throw new HttpError(404, 'unknown device');
      res.status(204).end();
    }),
  );

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error instanceof DuplicateDeviceError)
      return res.status(409).json({ error: 'device id already exists' });
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    log.error('request failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'internal error' });
  });
  return {
    app,
    async close() {
      clearInterval(evict);
      await Promise.all([...sessions.values()].map((s) => s.close()));
    },
  };
}

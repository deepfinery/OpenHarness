// Assembles registry, hub, HTTP app and WebSocket upgrade handling into one startable gateway.
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { LEGACY_SUBPROTOCOLS, SUBPROTOCOL, createLogger, type Logger } from '@openharness/connector-core';
import type { GatewayConfig } from './config.js';
import { createStorage, type Registry, type Storage } from './registry.js';
import { DeviceHub } from './hub.js';
import { createGatewayAudit } from './audit.js';
import { noopApproval, webhookApproval, studioApproval, type ApprovalProvider } from './approval.js';
import { createHttpApp } from './http.js';
import { applyBootstrapDevices } from './bootstrap.js';

export type Gateway = {
  server: HttpServer;
  hub: DeviceHub;
  registry: Registry;
  log: Logger;
  port: number;
  close(): Promise<void>;
};

export async function startGateway(
  config: GatewayConfig,
  overrides: { storage?: Storage; log?: Logger; approval?: ApprovalProvider } = {},
): Promise<Gateway> {
  const log = overrides.log ?? createLogger({ level: config.LOG_LEVEL, name: 'gateway' });
  if (!config.GATEWAY_API_TOKENS.trim())
    log.warn('GATEWAY_API_TOKENS is empty: no orchestrator can call this gateway');
  if (!config.GATEWAY_ADMIN_TOKEN)
    log.warn('GATEWAY_ADMIN_TOKEN is unset: the admin API is disabled; use the CLI to enroll devices');
  const storage = overrides.storage ?? (await createStorage(config));
  const registry = storage.registry;
  await applyBootstrapDevices(config.GATEWAY_BOOTSTRAP_DEVICES, registry, log);
  const hub = new DeviceHub({
    registry,
    clusters: storage.clusters,
    log,
    heartbeatSeconds: config.GATEWAY_HEARTBEAT_SECONDS,
    sessionRetentionMs: config.GATEWAY_SESSION_RETENTION_SECONDS * 1000,
    allowInsecure: config.GATEWAY_ALLOW_INSECURE_WS,
    trustProxy: config.TRUST_PROXY === '1' || config.TRUST_PROXY === 'true',
    helloRateLimitPerMinute: config.GATEWAY_HELLO_RATE_LIMIT,
  });
  const audit = createGatewayAudit(storage.audit, { file: config.GATEWAY_AUDIT_FILE });
  const approval =
    overrides.approval ??
    (config.GATEWAY_APPROVAL_PROVIDER === 'studio'
      ? studioApproval(config.GATEWAY_ADMIN_TOKEN ?? '', storage.consumeApproval)
      : config.GATEWAY_APPROVAL_PROVIDER === 'webhook' && config.GATEWAY_APPROVAL_URL
        ? webhookApproval(config.GATEWAY_APPROVAL_URL, config.GATEWAY_APPROVAL_TIMEOUT_SECONDS * 1000, log)
        : noopApproval);
  const http = createHttpApp({ config, registry, clusters: storage.clusters, hub, audit, approval, log });
  const server = createServer(http.app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    handleProtocols: (protocols) =>
      protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : (LEGACY_SUBPROTOCOLS.find((p) => protocols.has(p)) ?? false),
  });
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const offered = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim());
    if (path !== '/connect' || ![SUBPROTOCOL, ...LEGACY_SUBPROTOCOLS].some((p) => offered.includes(p))) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => hub.handleConnection(ws, request));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.PORT, config.HOST, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.PORT;
  log.info('gateway listening', {
    port,
    public_url: config.GATEWAY_PUBLIC_URL,
    insecure_ws: config.GATEWAY_ALLOW_INSECURE_WS,
  });
  return {
    server,
    hub,
    registry,
    log,
    port,
    async close() {
      hub.close();
      await http.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await storage.close();
    },
  };
}

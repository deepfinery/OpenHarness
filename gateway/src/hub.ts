// The device hub: authenticates `hello`, keeps one MCP Client per device socket, tracks liveness and resume.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolRequest, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CloseCode,
  FrameError,
  HANDSHAKE_TIMEOUT_MS,
  WebSocketServerTransport,
  encodeFrame,
  parseFrame,
  type HelloFrame,
  type Logger,
  type Platform,
} from '@agentic/connector-core';
import type { Registry } from './registry.js';
import { verifyDeviceToken } from './tokens.js';

export type DeviceSession = {
  sessionId: string;
  deviceId: string;
  platform: Platform;
  hostname: string;
  connectorVersion: string;
  capabilities: string[];
  connectedAt: Date;
  lastSeen: Date;
  online: boolean;
  tools?: Tool[];
  pending: number;
  socket?: WebSocket;
  transport?: WebSocketServerTransport;
  client?: Client;
  missedPings: number;
  timers: ReturnType<typeof setTimeout>[];
};
export type HubOptions = {
  registry: Registry;
  log: Logger;
  heartbeatSeconds?: number;
  sessionRetentionMs?: number;
  /** Require TLS at the edge unless explicitly disabled. */
  allowInsecure?: boolean;
  helloRateLimitPerMinute?: number;
};
export class HubError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
const OFFLINE_CODE = -32010;

export class DeviceHub {
  private sessions = new Map<string, DeviceSession>();
  private helloAttempts = new Map<string, { count: number; resetAt: number }>();
  private listeners = new Set<(event: { type: 'online' | 'offline' | 'tools'; deviceId: string }) => void>();
  private readonly heartbeatMs: number;
  private readonly retentionMs: number;
  constructor(private readonly options: HubOptions) {
    this.heartbeatMs = (options.heartbeatSeconds ?? 30) * 1000;
    this.retentionMs = options.sessionRetentionMs ?? 600_000;
  }
  onChange(listener: (event: { type: 'online' | 'offline' | 'tools'; deviceId: string }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: { type: 'online' | 'offline' | 'tools'; deviceId: string }) {
    for (const l of this.listeners) l(event);
  }
  /** Session for a device, online or retained after a disconnect. */
  session(deviceId: string) {
    return this.sessions.get(deviceId);
  }
  online(deviceId: string) {
    const s = this.sessions.get(deviceId);
    return s?.online ? s : undefined;
  }
  statuses() {
    return [...this.sessions.values()];
  }

  /** Entry point for accepted upgrades: performs the handshake, then hands the socket to an MCP Client. */
  handleConnection(socket: WebSocket, request: IncomingMessage) {
    const log = this.options.log;
    const address = String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? 'unknown')
      .split(',')[0]
      .trim();
    const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim();
    const encrypted =
      Boolean((request.socket as { encrypted?: boolean }).encrypted) || forwardedProto === 'https';
    if (!encrypted && !this.options.allowInsecure) {
      log.warn('rejected device socket without TLS', { address });
      socket.close(CloseCode.FORBIDDEN, 'tls required');
      return;
    }
    if (!this.allowHello(address)) {
      socket.close(CloseCode.RATE_LIMITED, 'rate limited');
      return;
    }
    const timer = setTimeout(
      () => socket.close(CloseCode.UNAUTHENTICATED, 'handshake timeout'),
      HANDSHAKE_TIMEOUT_MS,
    );
    socket.once('message', (data, isBinary) => {
      clearTimeout(timer);
      void (async () => {
        try {
          if (isBinary) throw new FrameError('binary frame', CloseCode.PROTOCOL_ERROR);
          const parsed = parseFrame(
            typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data),
          );
          if (parsed.kind !== 'hello') throw new FrameError('expected hello', CloseCode.UNAUTHENTICATED);
          await this.accept(socket, parsed.frame, address);
        } catch (error) {
          const code =
            error instanceof FrameError || error instanceof HubError ? error.code : CloseCode.PROTOCOL_ERROR;
          log.warn('device handshake failed', {
            address,
            code,
            reason: error instanceof Error ? error.message : String(error),
          });
          socket.close(
            code,
            code === CloseCode.UNAUTHENTICATED || code === CloseCode.FORBIDDEN ? '' : 'protocol error',
          );
        }
      })();
    });
    socket.once('close', () => clearTimeout(timer));
  }
  private allowHello(address: string) {
    const limit = this.options.helloRateLimitPerMinute ?? 20;
    const now = Date.now();
    const entry = this.helloAttempts.get(address);
    if (!entry || entry.resetAt < now) {
      this.helloAttempts.set(address, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  }
  private async accept(socket: WebSocket, hello: HelloFrame, address: string) {
    const log = this.options.log.child({ device_id: hello.device_id });
    const record = await this.options.registry.get(hello.device_id);
    if (!record || !(await verifyDeviceToken(record.token_hash, hello.token)))
      throw new HubError(CloseCode.UNAUTHENTICATED, 'unknown device or bad token');
    if (record.disabled) throw new HubError(CloseCode.FORBIDDEN, 'device disabled');
    if (record.platform !== hello.platform) throw new HubError(CloseCode.FORBIDDEN, 'platform mismatch');

    const previous = this.sessions.get(hello.device_id);
    if (previous?.online) {
      log.info('superseding an older connection');
      this.detach(previous, CloseCode.SUPERSEDED, 'superseded');
    }
    const resumed = Boolean(previous && !previous.online && hello.resume?.session_id === previous.sessionId);
    const session: DeviceSession = {
      sessionId: resumed ? previous!.sessionId : `sess_${randomBytes(12).toString('base64url')}`,
      deviceId: hello.device_id,
      platform: hello.platform,
      hostname: hello.hostname,
      connectorVersion: hello.connector_version,
      capabilities: hello.capabilities,
      connectedAt: new Date(),
      lastSeen: new Date(),
      online: true,
      tools: resumed ? previous!.tools : undefined,
      pending: 0,
      socket,
      missedPings: 0,
      timers: [],
    };
    for (const t of previous?.timers ?? []) clearTimeout(t);
    this.sessions.set(hello.device_id, session);
    socket.send(
      encodeFrame({
        type: 'welcome',
        session_id: session.sessionId,
        heartbeat_seconds: this.heartbeatMs / 1000,
        resumed,
        server_time: new Date().toISOString(),
      }),
    );
    const transport = new WebSocketServerTransport(socket, session.sessionId);
    transport.onactivity = () => {
      session.lastSeen = new Date();
      session.missedPings = 0;
    };
    transport.onerror = (error) => log.warn('device transport error', { error: error.message });
    const client = new Client({ name: 'agentic-gateway', version: '0.1.0' }, { capabilities: {} });
    client.setNotificationHandler(
      // The connector tells us when its tool list changes; refresh the cache and let orchestrator sessions know.
      (await import('@modelcontextprotocol/sdk/types.js')).ToolListChangedNotificationSchema,
      async () => {
        await this.refreshTools(session).catch(() => {});
        this.emit({ type: 'tools', deviceId: session.deviceId });
      },
    );
    session.transport = transport;
    session.client = client;
    transport.onclose = () => this.markOffline(session, 'socket closed');
    try {
      await client.connect(transport, { timeout: 30_000 });
      await this.refreshTools(session);
    } catch (error) {
      log.warn('device initialize failed', { error: error instanceof Error ? error.message : String(error) });
      this.detach(session, CloseCode.PROTOCOL_ERROR, 'initialize failed');
      return;
    }
    await this.options.registry.touch(session.deviceId, new Date()).catch(() => {});
    // Liveness: ping every heartbeat interval; two unanswered pings mark the device offline.
    const ping = setInterval(() => {
      if (!session.online) return clearInterval(ping);
      if (session.missedPings >= 2) {
        log.warn('device missed two heartbeats; closing');
        this.detach(session, CloseCode.GOING_AWAY, 'heartbeat');
        return;
      }
      session.missedPings++;
      try {
        socket.ping();
      } catch {}
      if (Date.now() - session.lastSeen.getTime() < this.heartbeatMs * 2)
        void this.options.registry.touch(session.deviceId, session.lastSeen).catch(() => {});
    }, this.heartbeatMs);
    session.timers.push(ping as unknown as ReturnType<typeof setTimeout>);
    log.info('device online', {
      session_id: session.sessionId,
      resumed,
      platform: hello.platform,
      hostname: hello.hostname,
      address,
      tools: session.tools?.length ?? 0,
    });
    this.emit({ type: 'online', deviceId: session.deviceId });
  }
  private async refreshTools(session: DeviceSession) {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20 && session.client; page++) {
      const result = await session.client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    session.tools = tools;
  }
  private detach(session: DeviceSession, code: number, reason: string) {
    const socket = session.socket;
    session.socket = undefined;
    try {
      socket?.close(code, reason);
    } catch {}
    this.markOffline(session, reason);
  }
  private markOffline(session: DeviceSession, reason: string) {
    if (!session.online) return;
    session.online = false;
    session.socket = undefined;
    for (const t of session.timers) clearTimeout(t);
    session.timers = [];
    void session.client?.close().catch(() => {});
    session.client = undefined;
    session.transport = undefined;
    void this.options.registry.touch(session.deviceId, new Date()).catch(() => {});
    this.options.log.info('device offline', { device_id: session.deviceId, reason });
    this.emit({ type: 'offline', deviceId: session.deviceId });
    // Keep the session for resume, then forget it.
    const forget = setTimeout(() => {
      if (this.sessions.get(session.deviceId) === session && !session.online)
        this.sessions.delete(session.deviceId);
    }, this.retentionMs);
    forget.unref();
    session.timers.push(forget);
  }
  async listTools(deviceId: string): Promise<{ tools: Tool[]; stale: boolean }> {
    const session = this.sessions.get(deviceId);
    if (!session) throw new HubError(OFFLINE_CODE, 'device offline');
    if (session.online && session.client) {
      if (!session.tools) await this.refreshTools(session);
      return { tools: session.tools ?? [], stale: false };
    }
    if (session.tools) return { tools: session.tools, stale: true };
    throw new HubError(OFFLINE_CODE, 'device offline');
  }
  async callTool(
    deviceId: string,
    params: CallToolRequest['params'],
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<CallToolResult> {
    const session = this.online(deviceId);
    if (!session?.client) throw new HubError(OFFLINE_CODE, 'device offline');
    session.pending++;
    try {
      return (await session.client.callTool(params, undefined, {
        timeout: options.timeoutMs,
        signal: options.signal,
        resetTimeoutOnProgress: true,
      })) as CallToolResult;
    } finally {
      session.pending--;
    }
  }
  /** Forcibly drops a device (admin removal or disable). */
  disconnect(deviceId: string, code: number = CloseCode.FORBIDDEN) {
    const session = this.sessions.get(deviceId);
    if (session) {
      this.detach(session, code, 'removed');
      this.sessions.delete(deviceId);
    }
  }
  close() {
    for (const session of this.sessions.values()) {
      this.detach(session, CloseCode.GOING_AWAY, 'shutdown');
      for (const t of session.timers) clearTimeout(t);
      session.timers = [];
    }
    this.sessions.clear();
  }
}

// Device-side MCP transport: dials the gateway over WebSocket, authenticates with `hello`, reconnects with
// backoff and resumes its session. Uses the standard WebSocket API so the same code runs in Node 22 and Chrome.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { backoffDelay } from './backoff.js';
import {
  CloseCode,
  DEFAULT_HEARTBEAT_SECONDS,
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  encodeFrame,
  parseFrame,
  type HelloFrame,
} from './frames.js';
import { silentLogger, type Logger } from './log.js';

/** The subset of the WHATWG WebSocket API the transport relies on. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike;
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'stopped';
export type DeviceIdentity = Omit<HelloFrame, 'type' | 'protocol_version' | 'token' | 'resume'>;
export type ClientTransportOptions = {
  url: string;
  identity: DeviceIdentity;
  token: string;
  /** Refuse plain ws:// unless explicitly allowed (development only). */
  allowInsecure?: boolean;
  heartbeatSeconds?: number;
  livenessTimeoutMs?: number;
  maxBackoffMs?: number;
  WebSocketImpl?: WebSocketConstructor;
  log?: Logger;
  random?: () => number;
  onStateChange?: (state: ConnectionState, info: { code?: number; reason?: string; attempt: number }) => void;
};
const OPEN = 1;
/** Close codes after which retrying cannot help until an operator intervenes. */
const FATAL_CODES = new Set<number>([CloseCode.FORBIDDEN, CloseCode.UNSUPPORTED_VERSION]);

export class WebSocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  private socket?: WebSocketLike;
  private phase: 'idle' | 'handshake' | 'mcp' = 'idle';
  private attempt = 0;
  private started = false;
  private stopped = false;
  private lastInbound = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly log: Logger;
  private readonly WebSocketImpl: WebSocketConstructor;

  constructor(private readonly options: ClientTransportOptions) {
    this.log = options.log ?? silentLogger;
    const impl = options.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!impl) throw new Error('No WebSocket implementation available');
    this.WebSocketImpl = impl;
    const url = new URL(options.url);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && options.allowInsecure))
      throw new Error('The gateway URL must use wss:// (set allowInsecure only for local development)');
    if (url.username || url.password || url.search)
      throw new Error('Credentials never travel in the gateway URL');
  }
  get state(): ConnectionState {
    return this.stopped
      ? 'stopped'
      : this.phase === 'mcp'
        ? 'connected'
        : this.socket
          ? 'connecting'
          : 'disconnected';
  }
  /** Resolves immediately; the connection is established (and re-established) in the background. */
  async start() {
    if (this.started) throw new Error('WebSocketClientTransport already started');
    this.started = true;
    this.connect();
  }
  async send(message: JSONRPCMessage) {
    if (!this.socket || this.socket.readyState !== OPEN || this.phase !== 'mcp')
      throw new Error('Device transport is not connected to the gateway');
    this.socket.send(encodeFrame(message));
  }
  async close() {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.phase = 'idle';
    try {
      socket?.close(1000, 'shutdown');
    } catch {}
    this.options.onStateChange?.('stopped', { attempt: this.attempt });
    this.onclose?.();
  }

  private connect() {
    if (this.stopped) return;
    this.phase = 'handshake';
    this.options.onStateChange?.('connecting', { attempt: this.attempt });
    let socket: WebSocketLike;
    try {
      socket = new this.WebSocketImpl(this.options.url, [SUBPROTOCOL]);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    const handshakeTimer = this.after(HANDSHAKE_TIMEOUT_MS, () => {
      if (this.socket === socket && this.phase === 'handshake') {
        this.log.warn('gateway handshake timed out');
        try {
          socket.close(CloseCode.PROTOCOL_ERROR, 'handshake timeout');
        } catch {}
        // Node's WebSocket does not emit `close` for a socket that never opened; settle the attempt here.
        this.socketClosed(socket, CloseCode.PROTOCOL_ERROR, 'handshake timeout');
      }
    });
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      const hello: HelloFrame = {
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        ...this.options.identity,
        token: this.options.token,
        ...(this.sessionId ? { resume: { session_id: this.sessionId } } : {}),
      };
      socket.send(encodeFrame(hello));
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      this.lastInbound = Date.now();
      let parsed;
      try {
        parsed = parseFrame(typeof event.data === 'string' ? event.data : String(event.data));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        socket.close(CloseCode.PROTOCOL_ERROR, 'bad frame');
        return;
      }
      if (parsed.kind === 'welcome') {
        clearTimeout(handshakeTimer);
        this.timers.delete(handshakeTimer);
        this.phase = 'mcp';
        this.sessionId = parsed.frame.session_id;
        this.startHeartbeat(parsed.frame.heartbeat_seconds);
        // A connection that survives a minute earns a fresh backoff schedule.
        this.after(60_000, () => {
          if (this.socket === socket && this.phase === 'mcp') this.attempt = 0;
        });
        this.log.info('connected to gateway', { session_id: this.sessionId, resumed: parsed.frame.resumed });
        this.options.onStateChange?.('connected', { attempt: this.attempt });
        return;
      }
      if (this.phase !== 'mcp') {
        socket.close(CloseCode.PROTOCOL_ERROR, 'message before welcome');
        return;
      }
      if (parsed.kind === 'rpc') this.onmessage?.(parsed.message);
      // heartbeat_ack and heartbeat only refresh liveness.
    });
    socket.addEventListener('error', () => {
      // Browsers follow a failed attempt with `close`; Node 22's built-in WebSocket only emits `error`. Treat an
      // error before the connection is open as the end of the attempt, or the reconnect loop would stall.
      if (socket.readyState !== OPEN) this.socketClosed(socket, 1006, 'connection failed');
    });
    socket.addEventListener('close', (event) => this.socketClosed(socket, event.code, event.reason));
  }
  /** Settles one connection attempt exactly once, whichever of close, error or a timeout reports it first. */
  private socketClosed(socket: WebSocketLike, code: number, reason: string) {
    const event = { code, reason };
    {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.phase = 'idle';
      this.clearTimers();
      if (this.stopped) return;
      this.options.onStateChange?.('disconnected', {
        code: event.code,
        reason: event.reason,
        attempt: this.attempt,
      });
      if (FATAL_CODES.has(event.code)) {
        this.stopped = true;
        this.log.error('gateway refused the device permanently', { code: event.code });
        this.options.onStateChange?.('stopped', {
          code: event.code,
          reason: event.reason,
          attempt: this.attempt,
        });
        this.onerror?.(new Error(`Gateway closed the connection with code ${event.code}`));
        this.onclose?.();
        return;
      }
      if (event.code === CloseCode.UNAUTHENTICATED) {
        // A wrong or not-yet-enrolled token: keep trying, slowly, so enrollment can complete later.
        this.attempt = Math.max(this.attempt, 6);
        this.log.warn('gateway rejected the device token; retrying with maximum backoff');
      }
      this.scheduleReconnect();
    }
  }
  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt, {
      maxMs: this.options.maxBackoffMs ?? 60_000,
      random: this.options.random,
    });
    this.attempt++;
    this.log.info('reconnecting to gateway', { in_ms: delay, attempt: this.attempt });
    this.after(delay, () => this.connect());
  }
  private startHeartbeat(seconds: number) {
    const interval = (this.options.heartbeatSeconds ?? seconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000;
    const liveness = this.options.livenessTimeoutMs ?? interval * 2;
    this.lastInbound = Date.now();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || this.phase !== 'mcp') return;
      if (Date.now() - this.lastInbound > liveness) {
        this.log.warn('no traffic from gateway; reconnecting');
        try {
          socket.close(CloseCode.GOING_AWAY, 'liveness');
        } catch {}
        this.socketClosed(socket, CloseCode.GOING_AWAY, 'liveness');
        return;
      }
      try {
        socket.send(encodeFrame({ type: 'heartbeat' }));
      } catch {}
    }, interval);
  }
  private after(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }
  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

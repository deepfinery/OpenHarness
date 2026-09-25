// Gateway-side MCP transport over one accepted WebSocket. The hub performs the `hello` handshake first and
// hands the socket over once `welcome` has been sent; from then on every frame is JSON-RPC or a heartbeat.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { CloseCode, encodeFrame, parseFrame } from './frames.js';

/** The subset of the `ws` server-side WebSocket API used here (also satisfied by a test double). */
export interface ServerSocketLike {
  readonly readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  ping?(): void;
  on(event: 'message', listener: (data: unknown, isBinary?: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'pong', listener: () => void): unknown;
}
const OPEN = 1;
export class WebSocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Called on every inbound frame or pong; the hub uses it for liveness. */
  onactivity?: () => void;
  sessionId?: string;
  private closed = false;
  constructor(
    private readonly socket: ServerSocketLike,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
  }
  async start() {
    this.socket.on('message', (data, isBinary) => {
      this.onactivity?.();
      if (isBinary) return this.fail('binary frames are not allowed');
      let parsed;
      try {
        parsed = parseFrame(
          typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data),
        );
      } catch (error) {
        // After welcome, every malformed frame is a protocol error; only oversize frames keep their own code.
        const code =
          (error as { code?: number }).code === CloseCode.TOO_LARGE
            ? CloseCode.TOO_LARGE
            : CloseCode.PROTOCOL_ERROR;
        return this.fail(error instanceof Error ? error.message : 'bad frame', code);
      }
      if (parsed.kind === 'heartbeat') {
        this.socket.send(encodeFrame({ type: 'heartbeat_ack', server_time: new Date().toISOString() }));
        return;
      }
      if (parsed.kind === 'rpc') return this.onmessage?.(parsed.message);
      this.fail(`unexpected ${parsed.kind} frame after welcome`);
    });
    this.socket.on('pong', () => this.onactivity?.());
    this.socket.on('error', (error) => this.onerror?.(error));
    this.socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
  }
  async send(message: JSONRPCMessage) {
    if (this.socket.readyState !== OPEN) throw new Error('Device socket is not open');
    await new Promise<void>((resolve, reject) =>
      this.socket.send(encodeFrame(message), (error) => (error ? reject(error) : resolve())),
    );
  }
  async close(code: number = 1000, reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {}
    this.onclose?.();
  }
  private fail(message: string, code: number = CloseCode.PROTOCOL_ERROR) {
    this.onerror?.(new Error(message));
    void this.close(code, 'protocol error');
  }
}

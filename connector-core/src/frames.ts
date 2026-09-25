// Wire frames of the device gateway protocol (docs/PROTOCOL.md). Everything after `welcome` is MCP JSON-RPC.
import { z } from 'zod';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export const PROTOCOL_VERSION = 1 as const;
export const SUBPROTOCOL = 'agentic-mcp.v1';
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_HEARTBEAT_SECONDS = 30;
export const platforms = ['linux', 'windows', 'chrome'] as const;
export type Platform = (typeof platforms)[number];
export const deviceIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** WebSocket close codes with protocol meaning. 4001 and 4003 never explain why. */
export const CloseCode = {
  GOING_AWAY: 1001,
  TOO_LARGE: 1009,
  UNAUTHENTICATED: 4001,
  FORBIDDEN: 4003,
  PROTOCOL_ERROR: 4008,
  SUPERSEDED: 4009,
  UNSUPPORTED_VERSION: 4013,
  RATE_LIMITED: 4029,
} as const;

export const helloFrame = z.object({
  type: z.literal('hello'),
  protocol_version: z.number().int(),
  device_id: z.string().regex(deviceIdPattern),
  platform: z.enum(platforms),
  hostname: z.string().max(253).default(''),
  token: z.string().min(16).max(512),
  connector_version: z.string().max(64).default('0.0.0'),
  capabilities: z.array(z.string().min(1).max(200)).max(200).default([]),
  resume: z.object({ session_id: z.string().min(1).max(128) }).optional(),
});
export const welcomeFrame = z.object({
  type: z.literal('welcome'),
  session_id: z.string().min(1).max(128),
  heartbeat_seconds: z.number().int().min(5).max(300),
  resumed: z.boolean(),
  server_time: z.string(),
});
export const heartbeatFrame = z.object({ type: z.literal('heartbeat') });
export const heartbeatAckFrame = z.object({ type: z.literal('heartbeat_ack'), server_time: z.string() });
export type HelloFrame = z.infer<typeof helloFrame>;
export type WelcomeFrame = z.infer<typeof welcomeFrame>;

export class FrameError extends Error {
  constructor(
    message: string,
    readonly code: number = CloseCode.PROTOCOL_ERROR,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}
export type ParsedFrame =
  | { kind: 'hello'; frame: HelloFrame }
  | { kind: 'welcome'; frame: WelcomeFrame }
  | { kind: 'heartbeat' }
  | { kind: 'heartbeat_ack'; frame: z.infer<typeof heartbeatAckFrame> }
  | { kind: 'rpc'; message: JSONRPCMessage };

/** Parses one text frame. Control frames carry `type`; anything else must be a single JSON-RPC message. */
export function parseFrame(text: string): ParsedFrame {
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES)
    throw new FrameError('frame too large', CloseCode.TOO_LARGE);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrameError('frame is not JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new FrameError('frame must be one JSON object');
  const type = (value as { type?: unknown }).type;
  if (typeof type === 'string') {
    switch (type) {
      case 'hello': {
        const parsed = helloFrame.safeParse(value);
        if (!parsed.success) throw new FrameError('invalid hello frame', CloseCode.UNAUTHENTICATED);
        if (parsed.data.protocol_version !== PROTOCOL_VERSION)
          throw new FrameError('unsupported protocol version', CloseCode.UNSUPPORTED_VERSION);
        return { kind: 'hello', frame: parsed.data };
      }
      case 'welcome': {
        const parsed = welcomeFrame.safeParse(value);
        if (!parsed.success) throw new FrameError('invalid welcome frame');
        return { kind: 'welcome', frame: parsed.data };
      }
      case 'heartbeat':
        return { kind: 'heartbeat' };
      case 'heartbeat_ack': {
        const parsed = heartbeatAckFrame.safeParse(value);
        if (!parsed.success) throw new FrameError('invalid heartbeat_ack frame');
        return { kind: 'heartbeat_ack', frame: parsed.data };
      }
      default:
        throw new FrameError(`unknown frame type ${type}`);
    }
  }
  const rpc = JSONRPCMessageSchema.safeParse(value);
  if (!rpc.success) throw new FrameError('frame is neither a control frame nor a JSON-RPC message');
  return { kind: 'rpc', message: rpc.data };
}
export const encodeFrame = (frame: object) => JSON.stringify(frame);

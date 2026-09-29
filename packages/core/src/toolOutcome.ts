import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AmbiguousToolCall } from './executionRecovery.js';

/** JSON-RPC codes the device gateway answers with (gateway/src/deviceServer.ts); the core does not import that package. */
const gatewayCode = {
  deviceOffline: -32010,
  toolNotAllowed: -32011,
  approvalDenied: -32012,
  deviceTimeout: -32013,
  deviceReconnected: -32014,
} as const;

export type ToolFailure = {
  /**
   * not_executed: the server answered that it did not run the call (offline, refused, invalid), so the model may
   * adjust and try again. unknown: no definitive answer arrived, so the call may have acted.
   */
  outcome: 'not_executed' | 'unknown';
  message: string;
};

/**
 * Sorts a failed tool call by what is known about its effect. A tool that answered with an error result never gets
 * here (that is an ordinary result); this covers thrown errors: transport, timeouts and server-side refusals.
 */
export function classifyToolFailure(error: unknown): ToolFailure {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1500);
  if (error instanceof AmbiguousToolCall) {
    // The durable-call journal wraps whatever the call threw. Classify the real failure when it is known.
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? classifyToolFailure(cause) : { outcome: 'unknown', message };
  }
  if (error instanceof McpError) {
    switch (error.code) {
      case ErrorCode.RequestTimeout:
      case ErrorCode.ConnectionClosed:
      case ErrorCode.InternalError:
      case gatewayCode.deviceTimeout:
      case gatewayCode.deviceReconnected:
        return { outcome: 'unknown', message };
      default:
        // Offline, not allowed, approval denied, invalid params, unknown tool: the server said it did not run it.
        return { outcome: 'not_executed', message };
    }
  }
  if (/not connected|transport (is |was )?closed|device offline/i.test(message))
    return { outcome: 'not_executed', message };
  return { outcome: 'unknown', message };
}

/** What the model reads when a call's effect cannot be confirmed: enough to verify, and a rule against repeating. */
export function uncertainToolResult(tool: string, failure: ToolFailure) {
  return (
    `Outcome unknown: ${failure.message}\n` +
    `The ${tool} call may or may not have taken effect. Do not repeat it blindly: check its effect with a read-only tool first (the process, file, service or state it would have changed), then continue from what you find. An identical call is refused for the rest of this run.`
  );
}

/** Long enough for a connector's default 60 s command timeout, and the gateway's 120 s default, to answer first. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 150_000;

/**
 * How long the runtime waits for a tool call. A tool that takes `timeout_seconds` gets that long plus a margin, so
 * the connector's own definitive timeout result always arrives before the runtime gives up; otherwise the default.
 */
export function toolCallTimeoutMs(args: unknown, fallback = DEFAULT_TOOL_CALL_TIMEOUT_MS) {
  const seconds = Number((args as { timeout_seconds?: unknown } | null | undefined)?.timeout_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return Math.max(fallback, Math.min(seconds, 3600) * 1000 + 15_000);
}

/** Identifies "the same call" for the rest of a run: the tool and its exact arguments. */
export const callSignature = (tool: string, args: unknown) => `${tool}:${JSON.stringify(args ?? {})}`;

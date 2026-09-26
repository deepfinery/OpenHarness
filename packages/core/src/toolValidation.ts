// Local JSON-Schema validation of MCP tool-call arguments before they leave the process.
// MCP servers validate too (e.g. Tavily rejects an out-of-enum `topic`), but a local check
// turns that into a clear, immediate message instead of an opaque JSON-RPC error, and lets
// an agent's tool loop retry with corrected arguments instead of crashing the whole run.
import { Ajv, type ValidateFunction } from 'ajv';
import type { ToolCall, ToolDefinition } from './llm.js';

export const MAX_TOOL_CALLS_PER_TURN = 20;
export class ToolSelectionRecoveryError extends Error {}
/** Check the whole batch before any side effect, against this pass's actual capabilities. */
export function validateToolSelection(calls: ToolCall[], offered: ToolDefinition[]) {
  const allowed = new Set(offered.map((tool) => tool.name));
  const unavailable = [...new Set(calls.filter((call) => !allowed.has(call.name)).map((call) => call.name))];
  const reason =
    calls.length > MAX_TOOL_CALLS_PER_TURN
      ? 'too_many_calls'
      : unavailable.length
        ? 'unavailable_tool'
        : undefined;
  if (!reason) return undefined;
  return {
    reason,
    unavailable: unavailable.slice(0, MAX_TOOL_CALLS_PER_TURN).map((name) => String(name).slice(0, 120)),
    feedback: `Not executed: the entire tool batch was rejected (${reason === 'too_many_calls' ? `at most ${MAX_TOOL_CALLS_PER_TURN} calls are allowed per turn` : 'one or more tool names are unavailable in this turn'}). No calls in this batch ran. Use only exact function names from the current tool definitions; match names mentioned in skills or notes to their descriptions. Do not guess aliases or repeat earlier successful calls. Current tools: ${JSON.stringify(offered.map((tool) => ({ name: tool.name, description: tool.description.slice(0, 100) })))}. If no available tool can do the task, explain that limitation.`,
  };
}

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
const cache = new WeakMap<Record<string, unknown>, ValidateFunction>();

function compile(schema: Record<string, unknown>): ValidateFunction {
  const cached = cache.get(schema);
  if (cached) return cached;
  const validate = ajv.compile(schema);
  cache.set(schema, validate);
  return validate;
}

/** Returns a human-readable error string, or null if `args` satisfies `schema`. */
export function validateToolArguments(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string | null {
  if (!schema || Object.keys(schema).length === 0) return null;
  let validate: ValidateFunction;
  try {
    validate = compile(schema);
  } catch {
    return null; // A tool with a schema we can't compile shouldn't block calls; the server still validates.
  }
  if (validate(args)) return null;
  const messages = (validate.errors ?? []).map((e) => {
    const path = e.instancePath ? e.instancePath.replace(/^\//, '') : (e.params as any)?.missingProperty;
    return path ? `${path} ${e.message}` : e.message;
  });
  return `Invalid arguments: ${messages.join('; ')}`;
}

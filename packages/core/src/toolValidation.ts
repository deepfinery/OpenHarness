// Local JSON-Schema validation of MCP tool-call arguments before they leave the process.
// MCP servers validate too (e.g. Tavily rejects an out-of-enum `topic`), but a local check
// turns that into a clear, immediate message instead of an opaque JSON-RPC error, and lets
// an agent's tool loop retry with corrected arguments instead of crashing the whole run.
import { Ajv, type ValidateFunction } from 'ajv';

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

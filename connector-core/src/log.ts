// JSON-lines logger shared by connectors and the gateway. Secret-looking keys are redacted before they are written.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
};
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i;

/** Replaces values whose key looks like a credential, recursively, and truncates long strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 2000)
    return `${value.slice(0, 2000)}…[+${value.length - 2000}]`;
  return value;
}
export function createLogger(
  options: {
    level?: LogLevel;
    name?: string;
    write?: (line: string) => void;
    base?: Record<string, unknown>;
  } = {},
): Logger {
  const level = options.level ?? ((process.env.LOG_LEVEL as LogLevel) || 'info');
  const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const base = { ...(options.name ? { name: options.name } : {}), ...(options.base ?? {}) };
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: lvl,
        msg,
        ...base,
        ...(redact(fields ?? {}) as object),
      }),
    );
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ level, write, base: { ...base, ...fields } }),
  };
}
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

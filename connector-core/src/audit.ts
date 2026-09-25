// Local audit trail: one JSON line per tool call. Arguments are redacted; the log never contains the token.
import { appendFile } from 'node:fs/promises';
import { redact } from './log.js';

export type AuditEntry = {
  tool: string;
  outcome: 'ok' | 'error' | 'denied' | 'timeout';
  duration_ms: number;
  arguments?: unknown;
  error?: string;
  idempotency_key?: string;
  [key: string]: unknown;
};
export type AuditLog = { write(entry: AuditEntry): Promise<void> };
export function createAuditLog(
  path?: string,
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): AuditLog {
  let queue: Promise<void> = Promise.resolve();
  return {
    write(entry) {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...(redact(entry) as object) });
      queue = queue
        .then(() => (path ? appendFile(path, line + '\n', { mode: 0o600 }) : sink(line)))
        .catch(() => {});
      return queue;
    },
  };
}

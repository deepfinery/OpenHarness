// Gateway audit: every tool call is stored (AuditStore) and mirrored as one JSON line for log pipelines.
// Arguments pass through a redaction hook before either.
import { appendFile } from 'node:fs/promises';
import { redact } from '@agentic/connector-core';
import type { AuditStore } from './registry.js';

export type AuditOutcome = 'ok' | 'error' | 'denied' | 'timeout' | 'offline' | 'approval_denied';
export type AuditRecord = {
  identity: string;
  device_id: string;
  tool: string;
  arguments: unknown;
  duration_ms: number;
  outcome: AuditOutcome;
  error?: string;
  session_id?: string;
};
export type RedactArguments = (tool: string, args: unknown) => unknown;
export const defaultRedaction: RedactArguments = (_tool, args) => redact(args);
export function createGatewayAudit(
  store: AuditStore,
  {
    file,
    redactArguments = defaultRedaction,
    sink,
  }: { file?: string; redactArguments?: RedactArguments; sink?: (line: string) => void } = {},
) {
  let queue = Promise.resolve();
  const write = sink ?? ((line: string) => process.stdout.write(line + '\n'));
  return {
    record(entry: AuditRecord) {
      const ts = new Date();
      const stored = { ...entry, ts, arguments: redactArguments(entry.tool, entry.arguments) };
      const line = JSON.stringify({ type: 'tool_call', ...stored, ts: ts.toISOString() });
      queue = queue
        .then(async () => {
          // A database hiccup must never fail the tool call; the JSON line still records it.
          await store.insert(stored).catch(() => {});
          if (file) await appendFile(file, line + '\n', { mode: 0o600 });
          else write(line);
        })
        .catch(() => {});
      return queue;
    },
  };
}
export type GatewayAudit = ReturnType<typeof createGatewayAudit>;

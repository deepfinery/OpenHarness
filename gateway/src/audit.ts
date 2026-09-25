// Gateway audit: one JSON line per tool call, with a redaction hook applied to the arguments.
import { appendFile } from 'node:fs/promises';
import { redact } from '@agentic/connector-core';

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
  path: string | undefined,
  redactArguments: RedactArguments = defaultRedaction,
  sink?: (line: string) => void,
) {
  let queue = Promise.resolve();
  const write = sink ?? ((line: string) => process.stdout.write(line + '\n'));
  return {
    record(entry: AuditRecord) {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        type: 'tool_call',
        ...entry,
        arguments: redactArguments(entry.tool, entry.arguments),
      });
      queue = queue
        .then(() => (path ? appendFile(path, line + '\n', { mode: 0o600 }) : write(line)))
        .catch(() => {});
      return queue;
    },
  };
}
export type GatewayAudit = ReturnType<typeof createGatewayAudit>;

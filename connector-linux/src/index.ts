import { registerGpuTools } from './gpu.js';
// Programmatic entry point: build a connector server without starting a transport (used by tests and the CLI).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Policy, createAuditLog, type ConnectorConfig } from '@openharness/connector-core';
import { linuxToolNames, registerLinuxTools } from './tools.js';

export { linuxToolNames, registerLinuxTools };
export const connectorVersion = '0.1.0';

export async function createConnectorServer(config: ConnectorConfig) {
  const policy = await Policy.create({
    workDir: config.work_dir,
    allowCommands: config.allow_commands,
    denyCommands: config.deny_commands,
    allowShell: config.allow_shell,
    maxOutputBytes: config.max_output_bytes,
    commandTimeoutMs: config.command_timeout_seconds * 1000,
    readOnly: config.read_only,
  });
  const audit = createAuditLog(config.audit_file);
  const server = new McpServer(
    { name: 'openharness-connector-linux', version: connectorVersion },
    { capabilities: { tools: { listChanged: true } } },
  );
  registerGpuTools(server, audit, {
    enabled: process.env.HOST_ACCESS === 'true',
    actions: config.read_only ? [] : (process.env.HOST_REMEDIATION_ACTIONS ?? '').split(',').filter(Boolean),
    stateDir: process.env.HOST_STATE_DIR ?? '/host-state',
  });
  registerLinuxTools(server, { policy, audit, hostname: config.hostname });
  return { server, policy, audit };
}

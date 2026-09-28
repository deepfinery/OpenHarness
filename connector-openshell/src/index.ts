// Programmatic entry point: build the OpenShell connector server without starting a transport (tests and CLI).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAuditLog, type ConnectorConfig } from '@openharness/connector-core';
import { loadOpenShellSettings, openshellSettingsSchema, type OpenShellSettings } from './config.js';
import { OPENSHELL_PINNED_VERSION, OpenShellCli, OpenShellError, type OpenShellDriver } from './openshell.js';
import { openshellToolNames, registerOpenShellTools } from './tools.js';

export {
  loadOpenShellSettings,
  openshellSettingsSchema,
  openshellToolNames,
  OpenShellCli,
  OPENSHELL_PINNED_VERSION,
};
export type { OpenShellSettings, OpenShellDriver };
export const connectorVersion = '0.1.0';

export async function createConnectorServer(
  config: ConnectorConfig,
  settings: OpenShellSettings,
  driver?: OpenShellDriver,
) {
  if (config.platform !== 'openshell')
    throw new Error('This connector registers as an OpenShell managed machine; set platform to "openshell"');
  const cli =
    driver ??
    new OpenShellCli({
      bin: settings.bin,
      gateway: settings.gateway,
      gatewayEndpoint: settings.gateway_endpoint,
      workspace: settings.workspace,
      timeoutMs: settings.cli_timeout_seconds * 1000,
      maxOutputBytes: config.max_output_bytes,
    });
  // Preflight: the CLI must exist. A version drift is reported, not fatal: the operator decides when to upgrade.
  const version = await cli.version();
  const warnings: string[] = [];
  if (!version.startsWith(OPENSHELL_PINNED_VERSION))
    warnings.push(
      `OpenShell CLI ${version} differs from the pinned release ${OPENSHELL_PINNED_VERSION}; re-verify the tools before relying on them`,
    );
  const audit = createAuditLog(config.audit_file);
  const server = new McpServer(
    { name: 'openharness-connector-openshell', version: connectorVersion },
    { capabilities: { tools: { listChanged: true } } },
  );
  registerOpenShellTools(server, {
    driver: cli,
    settings,
    audit,
    deviceId: config.device_id,
    maxOutputBytes: config.max_output_bytes,
  });
  return { server, audit, version, warnings };
}
export { OpenShellError };

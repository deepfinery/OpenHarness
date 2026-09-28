#!/usr/bin/env node
// CLI: `openharness-openshell-connector --config <file>` dials the device gateway from the OpenShell host;
// `--stdio` serves MCP on stdin/stdout for MCP Inspector and local testing.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketClientTransport, createLogger, loadConnectorConfig } from '@openharness/connector-core';
import {
  connectorVersion,
  createConnectorServer,
  loadOpenShellSettings,
  openshellToolNames,
} from './index.js';

function parseArgs(argv: string[]) {
  const args: { stdio?: boolean; config?: string; help?: boolean; printConfig?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdio') args.stdio = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--print-config') args.printConfig = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (/^(1|true|yes)$/i.test(process.env.CONNECTOR_STDIO ?? '')) args.stdio = true;
  if (args.help) {
    process.stdout.write(`openharness-openshell-connector ${connectorVersion}
  --config <file>   JSON config (default: $CONNECTOR_CONFIG, else environment only)
  --stdio           serve MCP over stdio instead of dialing the gateway (MCP Inspector); or CONNECTOR_STDIO=1
  --print-config    show the effective configuration (token redacted) and exit
Environment: GATEWAY_URL DEVICE_ID DEVICE_TOKEN|DEVICE_TOKEN_FILE GATEWAY_ALLOW_INSECURE MAX_OUTPUT_BYTES AUDIT_FILE LOG_LEVEL
             OPENSHELL_BIN OPENSHELL_GATEWAY OPENSHELL_GATEWAY_ENDPOINT OPENSHELL_WORKSPACE OPENSHELL_WORKSPACES
             OPENSHELL_ALLOW_POLICY_CHANGES OPENSHELL_ALLOW_SANDBOX_LIFECYCLE OPENSHELL_ALLOW_EXEC OPENSHELL_ALLOWED_IMAGES
             OPENSHELL_MAX_SANDBOXES OPENSHELL_MANAGE_ALL_SANDBOXES OPENSHELL_CLI_TIMEOUT_SECONDS
`);
    return;
  }
  const stdioDefaults = args.stdio
    ? {
        gateway_url: 'wss://stdio.invalid/connect',
        device_id: 'stdio',
        platform: 'openshell',
        token: 'stdio-mode-no-token-needed',
      }
    : {};
  const path = args.config ?? process.env.CONNECTOR_CONFIG;
  const { config, warnings } = await loadConnectorConfig({
    path,
    defaults: { platform: 'openshell', work_dir: process.cwd(), ...stdioDefaults },
  });
  const settings = await loadOpenShellSettings({ path });
  const log = createLogger({
    level: config.log_level,
    name: 'connector-openshell',
    write: (line) => process.stderr.write(line + '\n'),
  });
  for (const w of warnings) log.warn(w);
  const gateway = new URL(config.gateway_url);
  if (
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    (gateway.protocol !== 'wss:' && !(gateway.protocol === 'ws:' && config.allow_insecure))
  )
    throw new Error(
      'Use wss://, or explicitly enable insecure ws:// for development; credentials belong in the token setting',
    );
  if (args.printConfig) {
    process.stdout.write(
      JSON.stringify({ ...config, token: '[redacted]', openshell: settings }, null, 2) + '\n',
    );
    return;
  }
  const { server, version, warnings: preflight } = await createConnectorServer(config, settings);
  for (const w of preflight) log.warn(w);
  log.info('connector starting', {
    device_id: config.device_id,
    openshell_version: version,
    workspace: settings.workspace,
    allow_policy_changes: settings.allow_policy_changes,
    allow_sandbox_lifecycle: settings.allow_sandbox_lifecycle,
    allow_exec: settings.allow_exec,
    manage_all_sandboxes: settings.manage_all_sandboxes,
    tools: openshellToolNames,
  });
  const transport = args.stdio
    ? new StdioServerTransport()
    : new WebSocketClientTransport({
        url: config.gateway_url,
        allowInsecure: config.allow_insecure,
        token: config.token,
        identity: {
          device_id: config.device_id,
          platform: 'openshell',
          hostname: config.hostname,
          connector_version: connectorVersion,
          capabilities: [...openshellToolNames],
        },
        log,
        onStateChange: (state, info) =>
          log.info(`gateway ${state}`, { code: info.code, attempt: info.attempt }),
      });
  transport.onerror = (error) => log.warn('transport error', { error: error.message });
  await server.connect(transport);
  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({ level: 'error', msg: error instanceof Error ? error.message : String(error) }) + '\n',
  );
  process.exit(1);
});

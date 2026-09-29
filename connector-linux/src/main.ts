#!/usr/bin/env node
// CLI: `openharness-connector --config /etc/openharness-connector/config.json` dials the gateway;
// `openharness-connector --stdio` serves MCP on stdin/stdout for MCP Inspector and local testing.
import { connect as tlsConnect } from 'node:tls';
import { isIP } from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketClientTransport, createLogger, loadConnectorConfig } from '@openharness/connector-core';
import { connectorVersion, createConnectorServer, linuxToolNames } from './index.js';

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
  // Some launchers (MCP Inspector, IDE configs) cannot pass flags reliably; the environment works everywhere.
  if (/^(1|true|yes)$/i.test(process.env.CONNECTOR_STDIO ?? '')) args.stdio = true;
  if (args.help) {
    process.stdout.write(`openharness-connector ${connectorVersion}
  --config <file>   JSON config (default: $CONNECTOR_CONFIG, else environment only)
  --stdio           serve MCP over stdio instead of dialing the gateway (MCP Inspector); or CONNECTOR_STDIO=1
  --print-config    show the effective configuration (token redacted) and exit
Environment: GATEWAY_URL DEVICE_ID DEVICE_PLATFORM DEVICE_TOKEN|DEVICE_TOKEN_FILE WORK_DIR ALLOW_COMMANDS DENY_COMMANDS READ_ONLY MAX_OUTPUT_BYTES COMMAND_TIMEOUT_SECONDS AUDIT_FILE LOG_LEVEL GATEWAY_ALLOW_INSECURE
`);
    return;
  }
  const stdioDefaults = args.stdio
    ? {
        gateway_url: 'wss://stdio.invalid/connect',
        device_id: 'stdio',
        platform: 'linux',
        token: 'stdio-mode-no-token-needed',
      }
    : {};
  const { config, warnings } = await loadConnectorConfig({
    path: args.config ?? process.env.CONNECTOR_CONFIG,
    defaults: stdioDefaults,
  });
  const log = createLogger({
    level: config.log_level,
    name: 'connector-linux',
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
    process.stdout.write(JSON.stringify({ ...config, token: '[redacted]' }, null, 2) + '\n');
    return;
  }
  const { server, policy } = await createConnectorServer(config);
  log.info('connector starting', {
    device_id: config.device_id,
    work_dir: policy.workDir,
    read_only: policy.readOnly,
    access_mode: config.access_mode,
    tools: linuxToolNames,
    allow_commands: config.allow_commands,
  });
  let diagnosed = false;
  const transport = args.stdio
    ? new StdioServerTransport()
    : new WebSocketClientTransport({
        url: config.gateway_url,
        allowInsecure: config.allow_insecure,
        token: config.token,
        identity: {
          device_id: config.device_id,
          platform: config.platform,
          hostname: config.hostname,
          connector_version: connectorVersion,
          capabilities: [...linuxToolNames, ...(config.access_mode === 'host' ? ['host_full_access'] : [])],
        },
        log,
        onStateChange: (state, info) => {
          log.info(`gateway ${state}`, { code: info.code, attempt: info.attempt });
          // Node's WebSocket reports a failed handshake as a bare 1006; name the reason once (an untrusted
          // certificate is the usual one) so the operator does not have to guess.
          if (state === 'disconnected' && info.code === 1006 && !diagnosed) {
            diagnosed = true;
            void diagnoseGateway(gateway, log);
          }
        },
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
/** Probes the gateway's TLS endpoint directly and logs what the WebSocket handshake hid: an untrusted certificate or a refused connection. */
async function diagnoseGateway(
  gateway: URL,
  log: { warn: (message: string, fields?: Record<string, unknown>) => void },
) {
  if (gateway.protocol !== 'wss:') return;
  const host = gateway.hostname.replace(/^\[|\]$/g, '');
  const port = Number(gateway.port || 443);
  await new Promise<void>((resolve) => {
    const socket = tlsConnect({ host, port, ...(isIP(host) ? {} : { servername: host }) }, () => {
      socket.end();
      resolve();
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? error.message;
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) {
        log.warn('gateway certificate is not trusted by this connector', {
          error: code,
          hint: 'set NODE_EXTRA_CA_CERTS to the harness ca.crt (the install command in the studio embeds it)',
        });
      } else {
        log.warn('gateway TLS connection failed', { error: code, host, port });
      }
      resolve();
    });
  });
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({ level: 'error', msg: error instanceof Error ? error.message : String(error) }) + '\n',
  );
  process.exit(1);
});

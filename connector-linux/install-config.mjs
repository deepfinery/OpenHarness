// Called by the root installer. Preserve local policy while applying explicit enrollment settings.
import { readFileSync, writeFileSync } from 'node:fs';
import { connectorConfigSchema } from '../connector-core/dist/config.js';

const [source, destination, tokenFile] = process.argv.slice(2);
let config;
try {
  config = JSON.parse(readFileSync(source, 'utf8'));
} catch {
  throw new Error('Cannot read or parse the existing connector configuration');
}
if (!config || typeof config !== 'object' || Array.isArray(config))
  throw new Error('Connector configuration must be a JSON object');
config.gateway_url = process.env.GATEWAY_URL;
config.device_id = process.env.DEVICE_ID;
config.platform = 'linux';
config.token_file = tokenFile;
delete config.token; // An inline legacy token must not override the newly installed token file.
if (process.env.GATEWAY_ALLOW_INSECURE !== undefined) {
  const flag = process.env.GATEWAY_ALLOW_INSECURE;
  if (!/^(1|true|yes|on|0|false|no|off)$/i.test(flag))
    throw new Error('GATEWAY_ALLOW_INSECURE must be true or false');
  config.allow_insecure = /^(1|true|yes|on)$/i.test(flag);
}
let gateway;
try {
  gateway = new URL(config.gateway_url);
} catch {
  throw new Error('GATEWAY_URL must be a valid WebSocket URL');
}
if (
  !['ws:', 'wss:'].includes(gateway.protocol) ||
  gateway.username ||
  gateway.password ||
  gateway.search ||
  gateway.hash
)
  throw new Error(
    'GATEWAY_URL must be a ws:// or wss:// URL without credentials, a query string or a fragment',
  );
// Never print validation issues: an existing config may contain secrets or private fields.
if (!connectorConfigSchema.safeParse({ ...config, token: process.env.DEVICE_TOKEN }).success)
  throw new Error('Invalid connector configuration; check config.json and enrollment settings');
if (gateway.protocol === 'ws:' && !config.allow_insecure)
  console.error(
    'Warning: ws:// requires GATEWAY_ALLOW_INSECURE=true for local development. Use wss:// for encrypted connections.',
  );
writeFileSync(destination, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

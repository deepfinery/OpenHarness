import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent as HttpAgent } from 'undici';
import { config } from './config.js';

const scryptAsync = promisify(scrypt);
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function constantEqual(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString('hex')}`;
}
export async function passwordMatches(password: string, encoded: string) {
  const [, salt, key] = encoded.split(':');
  if (!salt || !key || key.length !== 128) return false;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return timingSafeEqual(derived, Buffer.from(key, 'hex'));
}
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.ENCRYPTION_KEY, 'hex'), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(value?: string) {
  if (!value) return '';
  const [iv, tag, data] = value.split('.').map((s) => Buffer.from(s, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(config.ENCRYPTION_KEY, 'hex'), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function privateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (a.startsWith('::ffff:')) {
    const tail = a.slice(7);
    if (tail.includes('.')) return privateAddress(tail);
    const parts = tail.split(':');
    if (parts.length === 2)
      return privateAddress(
        `${parseInt(parts[0], 16) >> 8}.${parseInt(parts[0], 16) & 255}.${parseInt(parts[1], 16) >> 8}.${parseInt(parts[1], 16) & 255}`,
      );
    return true;
  }
  if (isIP(a) === 6)
    return a === '::' || a === '::1' || /^(fc|fd|fe[89ab]|ff)/.test(a) || a.startsWith('2001:db8:');
  const [x, y] = a.split('.').map(Number);
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 100 && y >= 64 && y <= 127) ||
    x >= 224 ||
    (x === 198 && (y === 18 || y === 19))
  );
}
/** Hostname of the configured device gateway; its device endpoints are trusted like any listed private host. */
function gatewayHost() {
  try {
    return config.GATEWAY_URL ? new URL(config.GATEWAY_URL).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
export async function validateRemoteUrl(value: string) {
  const u = new URL(value);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new HttpError(400, 'Invalid remote URL');
  // Cloud metadata is never a supported tool/model endpoint, even in private-network mode.
  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === 'fd00:ec2::254')
    throw new HttpError(400, 'Metadata endpoints are prohibited');
  if (
    config.ALLOW_PRIVATE_URLS === 'true' ||
    config.ALLOWED_PRIVATE_HOSTS.split(',')
      .map((s) => s.trim().toLowerCase())
      .includes(host) ||
    gatewayHost() === host
  )
    return;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    throw new HttpError(
      400,
      'Private endpoint blocked. Add its hostname to ALLOWED_PRIVATE_HOSTS to use a trusted local server.',
    );
}
export function privateHostAllowed(host: string) {
  return (
    config.ALLOW_PRIVATE_URLS === 'true' ||
    config.ALLOWED_PRIVATE_HOSTS.split(',')
      .map((s) => s.trim().toLowerCase())
      .includes(host.toLowerCase())
  );
}
// Validate the addresses used by the socket itself, closing the DNS-rebinding gap
// between URL validation and the HTTP client's connection-time DNS resolution.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { all: true, verbatim: true })
    .then((addresses) => {
      if (
        addresses.some((a) =>
          ['169.254.169.254', 'fd00:ec2::254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe'].includes(
            a.address.toLowerCase(),
          ),
        )
      )
        throw new Error('Metadata endpoints are prohibited');
      if (!privateHostAllowed(hostname) && addresses.some((a) => privateAddress(a.address)))
        throw new Error('Connection resolved to a blocked private address');
      const family = Number(options.family) || 0;
      const valid = addresses.filter((a) => !family || a.family === family);
      if (!valid.length) throw new Error('Remote hostname has no allowed addresses');
      if (options.all) callback(null, valid);
      else callback(null, valid[0].address, valid[0].family);
    })
    .catch((error: Error) => callback(error, ''));
};
const remoteAgent = new HttpAgent({
  connect: { lookup: guardedLookup, timeout: 10000 },
  headersTimeout: 60000,
  bodyTimeout: 120000,
});
// Used for MCP discovery, OAuth and model requests. Redirects are rejected.
export const safeFetch: typeof fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : String(input);
  await validateRemoteUrl(target);
  const request: RequestInit & { dispatcher: HttpAgent } = {
    ...init,
    dispatcher: remoteAgent,
    redirect: 'manual',
    signal: init?.signal ?? AbortSignal.timeout(60000),
  };
  const response = await fetch(input, request);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new HttpError(400, 'Remote redirects are disabled; configure the final endpoint URL');
  }
  return response;
};
export function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unexpected error';
  return message
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|api_key|code|client_secret)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 1000);
}

// Connector configuration: a JSON file plus environment overrides, and a token that never appears in logs.
import { readFile, stat } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { z } from 'zod';
import { deviceIdPattern, platforms } from './frames.js';
import { defaultDenyCommands } from './policy.js';

export const connectorConfigSchema = z.object({
  gateway_url: z.string().url(),
  device_id: z.string().regex(deviceIdPattern),
  platform: z.enum(platforms),
  hostname: z.string().max(253).optional(),
  token: z.string().min(16).max(512).optional(),
  token_file: z.string().optional(),
  allow_insecure: z.boolean().default(false),
  work_dir: z.string().default('.'),
  allow_commands: z.array(z.string()).default([]),
  deny_commands: z.array(z.string()).default(defaultDenyCommands),
  allow_shell: z.boolean().default(false),
  max_output_bytes: z.number().int().min(1024).max(50_000_000).default(200_000),
  command_timeout_seconds: z.number().int().min(1).max(3600).default(60),
  read_only: z.boolean().default(false),
  audit_file: z.string().optional(),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  features: z.record(z.boolean()).default({}),
});
export type ConnectorConfig = z.infer<typeof connectorConfigSchema> & { token: string; hostname: string };

const list = (value?: string) =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
const bool = (value?: string) => (value === undefined ? undefined : /^(1|true|yes|on)$/i.test(value));
const num = (value?: string) => (value === undefined || value === '' ? undefined : Number(value));
const strip = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Environment overrides, for containers and services that carry no config file. */
export function configFromEnv(env: NodeJS.ProcessEnv) {
  return strip({
    gateway_url: env.GATEWAY_URL,
    device_id: env.DEVICE_ID,
    platform: env.DEVICE_PLATFORM,
    hostname: env.DEVICE_HOSTNAME,
    token: env.DEVICE_TOKEN,
    token_file: env.DEVICE_TOKEN_FILE,
    allow_insecure: bool(env.GATEWAY_ALLOW_INSECURE),
    work_dir: env.WORK_DIR,
    allow_commands: list(env.ALLOW_COMMANDS),
    deny_commands: list(env.DENY_COMMANDS),
    allow_shell: bool(env.ALLOW_SHELL),
    max_output_bytes: num(env.MAX_OUTPUT_BYTES),
    command_timeout_seconds: num(env.COMMAND_TIMEOUT_SECONDS),
    read_only: bool(env.READ_ONLY),
    audit_file: env.AUDIT_FILE,
    log_level: env.LOG_LEVEL,
  });
}
/** Reads a token file and warns when it is readable by others (POSIX). */
export async function readTokenFile(path: string) {
  const info = await stat(path);
  const warnings: string[] = [];
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    warnings.push(`token file ${path} is readable by other users; chmod 600 it`);
  const token = (await readFile(path, 'utf8')).trim();
  if (!token) throw new Error(`token file ${path} is empty`);
  return { token, warnings };
}
export async function loadConnectorConfig({
  path,
  env = process.env,
  defaults = {},
}: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  defaults?: Record<string, unknown>;
}): Promise<{ config: ConnectorConfig; warnings: string[] }> {
  let fromFile: Record<string, unknown> = {};
  if (path) {
    const text = await readFile(path, 'utf8').catch((cause: NodeJS.ErrnoException) => {
      throw new Error(
        cause.code === 'ENOENT'
          ? `config file not found: ${path}`
          : `cannot read config file ${path}: ${cause.code ?? 'unknown error'} (${cause.message})`,
        { cause },
      );
    });
    fromFile = JSON.parse(text) as Record<string, unknown>;
  }
  const parsed = connectorConfigSchema.parse({ ...defaults, ...fromFile, ...configFromEnv(env) });
  const warnings: string[] = [];
  let token = parsed.token;
  if (!token && parsed.token_file) {
    const read = await readTokenFile(parsed.token_file);
    token = read.token;
    warnings.push(...read.warnings);
  }
  if (!token)
    throw new Error('No device token: set "token_file" in the config, or DEVICE_TOKEN / DEVICE_TOKEN_FILE');
  if (path && fromFile.token)
    warnings.push('the token is stored in the config file; prefer token_file with mode 0600');
  return { config: { ...parsed, token, hostname: parsed.hostname ?? osHostname() }, warnings };
}

#!/usr/bin/env node
// Operator CLI working directly on the registry, so devices can be enrolled before the gateway runs.
//   agentic-gateway enroll --id laptop-1 --platform linux [--name "Laptop"] [--owner team] [--allow run_command,read_file]
//   agentic-gateway list | allow <id> tool,tool | disable <id> | enable <id> | remove <id> | rotate <id>
import { loadConfig } from './config.js';
import { createStorage } from './registry.js';
import { generateDeviceToken, hashDeviceToken } from './tokens.js';
import { deviceIdPattern, platforms } from '@agentic/connector-core';

function flags(argv: string[]) {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
    else rest.push(argv[i]);
    if (argv[i].startsWith('--')) i++;
  }
  return { flags: out, rest };
}
const config = loadConfig();
const storage = await createStorage(config);
const registry = storage.registry;
const [command, ...args] = process.argv.slice(2);
const { flags: f, rest } = flags(args);
const print = (value: unknown) =>
  process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
const tools = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
try {
  switch (command) {
    case 'enroll': {
      const id = f.id;
      if (!id || !deviceIdPattern.test(id)) throw new Error('--id must match ^[a-z0-9][a-z0-9-]{0,62}$');
      if (!platforms.includes(f.platform as (typeof platforms)[number]))
        throw new Error(`--platform must be one of ${platforms.join(', ')}`);
      if (await registry.get(id)) throw new Error(`device ${id} already exists`);
      const token = generateDeviceToken();
      await registry.create({
        device_id: id,
        name: f.name ?? '',
        platform: f.platform as (typeof platforms)[number],
        owner: f.owner ?? '',
        allowed_tools: tools(f.allow),
        token_hash: await hashDeviceToken(token),
        created_at: new Date().toISOString(),
        disabled: false,
      });
      print(
        `Enrolled ${id} (${f.platform}). Allowed tools: ${tools(f.allow).join(', ') || 'none (deny by default)'}`,
      );
      print(
        `One-time device token (shown once, stored hashed):\n\n  ${token}\n\nConnector settings: GATEWAY_URL=${config.GATEWAY_PUBLIC_URL.replace(/\/$/, '')}/connect DEVICE_ID=${id} DEVICE_TOKEN=<token>`,
      );
      break;
    }
    case 'list':
      print((await registry.list(f.owner)).map(({ token_hash, ...d }) => d));
      break;
    case 'allow': {
      const [id, list] = rest;
      if (!(await registry.update(id, { allowed_tools: tools(list) }))) throw new Error('unknown device');
      print(`Allowed tools for ${id}: ${tools(list).join(', ') || 'none'}`);
      break;
    }
    case 'disable':
    case 'enable': {
      if (!(await registry.update(rest[0], { disabled: command === 'disable' })))
        throw new Error('unknown device');
      print(`${rest[0]} ${command}d`);
      break;
    }
    case 'remove':
      if (!(await registry.delete(rest[0]))) throw new Error('unknown device');
      print(`${rest[0]} removed`);
      break;
    case 'rotate': {
      const token = generateDeviceToken();
      if (!(await registry.update(rest[0], { token_hash: await hashDeviceToken(token) })))
        throw new Error('unknown device');
      print(`New token for ${rest[0]} (shown once):\n\n  ${token}`);
      break;
    }
    default:
      print(
        'usage: agentic-gateway enroll --id <id> --platform linux|windows|chrome [--name n] [--owner o] [--allow t1,t2] | list [--owner o] | allow <id> t1,t2 | disable <id> | enable <id> | remove <id> | rotate <id>',
      );
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await storage.close();
}

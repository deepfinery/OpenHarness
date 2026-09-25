import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectorConfigSchema } from '@openharness/connector-core';
import { createConnectorServer, linuxToolNames } from '../src/index.js';

async function connectedClient(overrides: Record<string, unknown> = {}) {
  const work = await mkdtemp(join(tmpdir(), 'connector-'));
  await mkdir(join(work, 'docs'));
  await writeFile(join(work, 'docs', 'readme.md'), 'hello from the work dir\nsecond line with needle\n');
  const config = {
    ...connectorConfigSchema.parse({
      gateway_url: 'wss://gateway.test/connect',
      device_id: 'test-box',
      platform: 'linux',
      token: 'dv_0123456789abcdef',
      work_dir: work,
      allow_commands: ['echo', 'cat', 'sleep', 'sh'],
      max_output_bytes: 2000,
      command_timeout_seconds: 1,
      ...overrides,
    }),
    token: 'dv_0123456789abcdef',
    hostname: 'test-host',
  };
  const { server } = await createConnectorServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return { client, work };
}
const call = (client: Client, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
  client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }) as Promise<any>;

test('the Linux connector exposes its tools and enforces the command allow-list, timeout and output cap', async () => {
  const { client } = await connectedClient();
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [...linuxToolNames].sort());
  const ok = await call(client, 'run_command', { argv: ['echo', 'hello'] });
  assert.equal(ok.isError, false);
  assert.equal(ok.structuredContent.exit_code, 0);
  assert.match(ok.structuredContent.stdout, /hello/);
  const denied = await call(client, 'run_command', { argv: ['rm', '-rf', '/'] });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /denied by policy/);
  const notAllowed = await call(client, 'run_command', { argv: ['curl', 'https://example.com'] });
  assert.match(notAllowed.content[0].text, /not on the allow-list/);
  const slow = await call(client, 'run_command', { argv: ['sleep', '5'] });
  assert.equal(slow.isError, true);
  assert.match(slow.content[0].text, /timed out/);
  const big = await call(client, 'run_command', {
    argv: ['sh', '-c', 'head -c 10000 /dev/zero | tr "\\0" x'],
  });
  assert.equal(big.structuredContent.truncated, true);
  assert.ok(big.structuredContent.stdout.length <= 2000);
  const failing = await call(client, 'run_command', { argv: ['sh', '-c', 'exit 3'] });
  assert.equal(failing.isError, true);
  assert.equal(failing.structuredContent.exit_code, 3);
});
test('file tools stay inside the work directory and honour read-only mode; replays are idempotent', async () => {
  const { client, work } = await connectedClient();
  const read = await call(client, 'read_file', { path: 'docs/readme.md' });
  assert.match(read.structuredContent.content, /hello from the work dir/);
  const escape = await call(client, 'read_file', { path: '../../etc/passwd' });
  assert.equal(escape.isError, true);
  assert.match(escape.content[0].text, /outside the work directory/);
  const absolute = await call(client, 'read_file', { path: '/etc/passwd' });
  assert.equal(absolute.isError, true);
  const written = await call(
    client,
    'write_file',
    { path: 'out/new.txt', content: 'one' },
    { idempotencyKey: 'k1' },
  );
  assert.equal(written.isError, undefined);
  assert.equal(written.structuredContent.path, join(work, 'out', 'new.txt'));
  const replay = await call(
    client,
    'write_file',
    { path: 'out/new.txt', content: 'two' },
    { idempotencyKey: 'k1' },
  );
  assert.deepEqual(replay.structuredContent, written.structuredContent, 'same key returns the stored result');
  assert.match((await call(client, 'read_file', { path: 'out/new.txt' })).structuredContent.content, /^one$/);
  const listed = await call(client, 'list_dir', { path: '.', depth: 2 });
  assert.ok(listed.structuredContent.entries.some((e: any) => e.path === join('docs', 'readme.md')));
  const found = await call(client, 'search_files', { path: '.', name_pattern: '*.md', content: 'needle' });
  assert.equal(found.structuredContent.matches.length, 1);
  assert.equal(found.structuredContent.matches[0].line, 2);
  const info = await call(client, 'system_info', {});
  assert.equal(info.structuredContent.hostname, 'test-host');
  const procs = await call(client, 'process_list', {});
  assert.ok(procs.structuredContent.count >= 1);
  const ro = await connectedClient({ read_only: true });
  const blocked = await call(ro.client, 'write_file', { path: 'x.txt', content: 'y' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /read-only/);
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketClientTransport, silentLogger } from '@openharness/connector-core';
import { gatewayConfigSchema } from '../src/config.js';
import { startGateway, type Gateway } from '../src/server.js';
import { memoryStorage } from '../src/registry.js';
import { generateDeviceToken, hashDeviceToken } from '../src/tokens.js';

let gateway: Gateway;
let dataDir: string;
const ORCH_TOKEN = 'orch-secret-token-0123456789';
const ADMIN_TOKEN = 'admin-secret-token-0123456789';
const deviceToken = generateDeviceToken();
let base = '';
let device: { server: McpServer; transport: WebSocketClientTransport } | undefined;

/** A tiny device: an MCP server with an echo tool and a slow tool, dialing the gateway like a real connector. */
async function startDevice(id: string, token = deviceToken, hostAccess = false) {
  const server = new McpServer({ name: 'test-device', version: '0.0.1' });
  server.registerTool(
    'echo',
    { description: 'echo', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }], structuredContent: { text } }),
  );
  server.registerTool('slow', { description: 'slow', inputSchema: {} }, async () => {
    await new Promise((r) => setTimeout(r, 3000));
    return { content: [{ type: 'text', text: 'late' }] };
  });
  server.registerTool('secret', { description: 'not allowed', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'x' }],
  }));
  const states: string[] = [];
  const transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${gateway.port}/connect`,
    allowInsecure: true,
    token,
    identity: {
      device_id: id,
      platform: 'linux',
      hostname: 'test-host',
      connector_version: '0.0.1',
      capabilities: ['echo', 'slow', 'secret', ...(hostAccess ? ['host_full_access'] : [])],
    },
    log: silentLogger,
    onStateChange: (s) => states.push(s),
  });
  await server.connect(transport);
  return { server, transport, states };
}
const waitFor = async (predicate: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
};
async function orchestratorClient(target: string, token = ORCH_TOKEN) {
  const client = new Client({ name: 'orchestrator-test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/${target}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}
const admin = (path: string, method = 'GET', body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const storage = memoryStorage();
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'gateway-'));
  gateway = await startGateway(
    gatewayConfigSchema.parse({
      PORT: '0',
      HOST: '127.0.0.1',
      GATEWAY_API_TOKENS: `orchestrator:${ORCH_TOKEN}`,
      GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
      GATEWAY_ALLOW_INSECURE_WS: 'true',
      GATEWAY_TOOL_TIMEOUTS: 'slow=1',
      GATEWAY_APPROVAL_TOOLS: 'secret',
      GATEWAY_AUDIT_FILE: join(dataDir, 'audit.jsonl'),
      GATEWAY_HEARTBEAT_SECONDS: '5',
      GATEWAY_PUBLIC_URL: 'ws://127.0.0.1:0',
      LOG_LEVEL: 'error',
    }),
    {
      storage,
      log: silentLogger,
      approval: { decide: async ({ tool }) => (tool === 'secret' ? 'denied' : 'approved') },
    },
  );
  base = `http://127.0.0.1:${gateway.port}`;
  await gateway.registry.create({
    device_id: 'dev-1',
    name: 'Device one',
    platform: 'linux',
    owner: 'tenant-a',
    allowed_tools: ['echo', 'slow', 'secret'],
    token_hash: await hashDeviceToken(deviceToken),
    created_at: new Date().toISOString(),
    disabled: false,
  });
});
after(async () => {
  await device?.server.close().catch(() => {});
  await gateway.close();
});

test('health endpoints answer and MCP endpoints require the orchestrator bearer token', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const anonymous = await fetch(`${base}/mcp/dev-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(anonymous.status, 401);
  const wrong = await fetch(`${base}/mcp/dev-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer nope' },
    body: '{}',
  });
  assert.equal(wrong.status, 401);
  await assert.rejects(orchestratorClient('nobody'), /404|unknown device/i);
});
test('an unknown device token is refused with 4001 and the connector keeps retrying instead of dying', async () => {
  const bad = await startDevice('dev-1', 'dv_wrong-token-0123456789abcdef');
  await waitFor(() => bad.states.includes('disconnected'));
  assert.equal(bad.transport.state, 'disconnected', 'not stopped: a later enrollment may fix it');
  await bad.server.close();
});
test('a device dials in, is listed as online, and the orchestrator calls its tools through the gateway', async () => {
  device = await startDevice('dev-1');
  await waitFor(() => Boolean(gateway.hub.online('dev-1')));
  const fleet = await orchestratorClient('fleet');
  const listed = (await fleet.callTool({ name: 'list_devices', arguments: {} })) as any;
  const dev = listed.structuredContent.devices.find((d: any) => d.device_id === 'dev-1');
  assert.equal(dev.online, true);
  assert.equal(dev.hostname, 'test-host');
  assert.equal(dev.tool_count, 3);
  await fleet.close();

  const client = await orchestratorClient('dev-1');
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['echo', 'secret', 'slow']);
  const echoed = (await client.callTool({
    name: 'echo',
    arguments: { text: 'hi there' },
    _meta: { idempotencyKey: 'k1' },
  })) as any;
  assert.equal(echoed.structuredContent.text, 'hi there');
  // Approval hook denies `secret`; timeout override cuts `slow` at 1 s.
  await assert.rejects(
    client.callTool({ name: 'secret', arguments: {} }),
    (e: McpError) => e.code === -32012,
  );
  await assert.rejects(client.callTool({ name: 'slow', arguments: {} }), (e: McpError) => e.code === -32013);
  // A second orchestrator session multiplexes over the same device socket.
  const second = await orchestratorClient('dev-1');
  const both = await Promise.all([
    client.callTool({ name: 'echo', arguments: { text: 'a' } }),
    second.callTool({ name: 'echo', arguments: { text: 'b' } }),
  ]);
  assert.deepEqual(
    both.map((r: any) => r.structuredContent.text),
    ['a', 'b'],
  );
  await second.close();
  await client.close();
  const audit = (await readFile(join(dataDir, 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.ok(
    audit.some(
      (a) =>
        a.tool === 'echo' && a.outcome === 'ok' && a.identity === 'orchestrator' && a.device_id === 'dev-1',
    ),
  );
  assert.ok(audit.some((a) => a.tool === 'secret' && a.outcome === 'approval_denied'));
  // The same calls are persisted in the audit store (MongoDB in production).
  const stored = await storage.audit.recent({ device_id: 'dev-1' });
  assert.ok(stored.some((a) => a.tool === 'echo' && a.outcome === 'ok'));
  assert.ok(stored.every((a) => a.ts instanceof Date));
  assert.ok(audit.some((a) => a.tool === 'slow' && a.outcome === 'timeout'));
});
test('the per-device allow-list is enforced at the gateway independently of the connector', async () => {
  const updated = await admin('/admin/devices/dev-1', 'PUT', { allowed_tools: ['echo'] });
  assert.equal(updated.status, 200);
  const client = await orchestratorClient('dev-1');
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ['echo'],
  );
  await assert.rejects(client.callTool({ name: 'slow', arguments: {} }), (e: McpError) => e.code === -32011);
  await client.close();
});
test('when the device disconnects the endpoint stays up, reports offline, and the device resumes its session', async () => {
  const sessionBefore = gateway.hub.session('dev-1')!.sessionId;
  // Simulate a network drop: close the device's socket without stopping the connector (an app code the transport retries on).
  (device!.transport as any).socket.close(4000, 'test drop');
  await waitFor(() => !gateway.hub.online('dev-1'));
  const client = await orchestratorClient('dev-1');
  await assert.rejects(
    client.callTool({ name: 'echo', arguments: { text: 'x' } }),
    (e: McpError) => e.code === -32010,
  );
  const cached = await client.listTools();
  assert.deepEqual(
    cached.tools.map((t) => t.name),
    ['echo'],
    'cached list is served while offline',
  );
  assert.equal((cached as any)._meta?.stale, true);
  await waitFor(() => Boolean(gateway.hub.online('dev-1')), 10_000);
  assert.equal(gateway.hub.session('dev-1')!.sessionId, sessionBefore, 'session id resumed');
  const echoed = (await client.callTool({ name: 'echo', arguments: { text: 'back' } })) as any;
  assert.equal(echoed.structuredContent.text, 'back');
  await client.close();
});
test('admin API enrolls devices with a one-time token, deny-by-default tools, and removes them', async () => {
  const created = await admin('/admin/devices', 'POST', {
    device_id: 'box-2',
    platform: 'linux',
    owner: 'tenant-a',
    name: 'Box 2',
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as any;
  assert.match(body.token, /^dv_/);
  assert.deepEqual(body.device.allowed_tools, []);
  assert.equal(
    (await admin('/admin/devices', 'POST', { device_id: 'box-2', platform: 'linux' })).status,
    409,
  );
  const list = (await (await admin('/admin/devices?owner=tenant-a')).json()) as any;
  assert.deepEqual(list.devices.map((d: any) => d.device_id).sort(), ['box-2', 'dev-1']);
  assert.equal((await fetch(`${base}/admin/devices`)).status, 401);
  assert.equal((await admin('/admin/devices/box-2', 'DELETE')).status, 204);
  assert.equal((await admin('/admin/devices/box-2', 'DELETE')).status, 404);
});

test('the admin API calls a connector tool for the studio, audited, without the per-device allow-list', async () => {
  device ??= await startDevice('dev-1');
  await waitFor(() => gateway.hub.session('dev-1')?.online === true);
  const call = (body: unknown, id = 'dev-1') => admin(`/admin/devices/${id}/call`, 'POST', body);
  // `secret` is enrolled but approval-gated for agents; the console path reaches it under the admin token.
  const ok = await call({ tool: 'echo', arguments: { text: 'from the console' } });
  assert.equal(ok.status, 200);
  const { result } = (await ok.json()) as {
    result: { structuredContent: { text: string }; isError?: boolean };
  };
  assert.equal(result.structuredContent.text, 'from the console');
  assert.equal((await call({ tool: 'secret' })).status, 200, 'no approval hook on the admin path');
  assert.equal((await call({ tool: 'slow' })).status, 504, 'the per-tool timeout still applies');
  assert.equal((await call({ tool: 'echo' }, 'nope')).status, 404);
  assert.equal((await call({ arguments: {} })).status, 400, 'a tool name is required');
  const unauthenticated = await fetch(`${base}/admin/devices/dev-1/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ORCH_TOKEN}` },
    body: JSON.stringify({ tool: 'echo', arguments: { text: 'x' } }),
  });
  assert.equal(unauthenticated.status, 401, 'the orchestrator MCP token does not open the admin path');
  const audit = (await readFile(join(dataDir, 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { identity: string; tool: string; outcome: string });
  const entry = audit.filter((a) => a.identity === 'admin' && a.tool === 'echo').at(-1);
  assert.ok(entry, 'the console call is audited under the admin identity');
  assert.equal(entry.outcome, 'ok');
  assert.ok(audit.some((a) => a.identity === 'admin' && a.tool === 'slow' && a.outcome === 'timeout'));
  await gateway.registry.update('dev-1', { disabled: true });
  assert.equal(
    (await call({ tool: 'echo', arguments: { text: 'x' } })).status,
    409,
    'a disabled machine is refused',
  );
  await gateway.registry.update('dev-1', { disabled: false });
});

test('privileged connector registration needs explicit machine permission and is revoked on restriction', async () => {
  await gateway.registry.create({
    device_id: 'host-access-test',
    name: 'Host access',
    platform: 'linux',
    owner: 'tenant-a',
    allowed_tools: ['echo'],
    token_hash: await hashDeviceToken(deviceToken),
    created_at: new Date().toISOString(),
    disabled: false,
  });
  const denied = await startDevice('host-access-test', deviceToken, true);
  try {
    await waitFor(() => denied.states.includes('stopped') || denied.states.includes('disconnected'));
    assert.ok(!gateway.hub.session('host-access-test')?.online);
  } finally {
    await denied.server.close();
  }
  assert.equal((await admin('/admin/devices/host-access-test', 'PUT', { access_mode: 'host' })).status, 200);
  const allowed = await startDevice('host-access-test', deviceToken, true);
  let client: Client | undefined;
  try {
    await waitFor(() => !!gateway.hub.session('host-access-test')?.online);
    client = await orchestratorClient('host-access-test');
    const result: any = await client.callTool({ name: 'echo', arguments: { text: 'host access allowed' } });
    assert.match(result.content[0].text, /host access allowed/);
    assert.equal(
      (await admin('/admin/devices/host-access-test', 'PUT', { access_mode: 'restricted' })).status,
      200,
    );
    await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'must not execute' } }));
    await waitFor(() => !gateway.hub.session('host-access-test')?.online);
  } finally {
    await client?.close();
    await allowed.server.close();
  }
});

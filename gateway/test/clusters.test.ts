import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport, silentLogger } from '@openharness/connector-core';
import { z } from 'zod';
import { memoryStorage } from '../src/registry.js';
import { clusterSchema, MemoryClusters } from '../src/clusters.js';
import { gatewayConfigSchema } from '../src/config.js';
import { startGateway } from '../src/server.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test('shared cluster key enrolls distinct nodes, enforces ownership, permissions, capacity, rotation and disable', async () => {
  const storage = memoryStorage();
  const gateway = await startGateway(
    gatewayConfigSchema.parse({
      PORT: 0,
      HOST: '127.0.0.1',
      GATEWAY_ALLOW_INSECURE_WS: true,
      GATEWAY_ADMIN_TOKEN: 'test-admin',
      GATEWAY_API_TOKENS: 'tests:test-orchestrator',
    }),
    { storage, log: silentLogger },
  );
  const servers: McpServer[] = [];
  let effects = 0;
  const base = `http://127.0.0.1:${gateway.port}`;
  const admin = async (path: string, body?: any, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + '/admin' + path, {
      method,
      headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(r.ok);
    return r.json();
  };
  const connect = async (id: string, token: string) => {
    const server = new McpServer({ name: 'test-cluster-node', version: '1' });
    servers.push(server);
    server.registerTool('system_info', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: id }],
    }));
    server.registerTool('gpu_remediate', { inputSchema: { action: z.string() } }, async () => {
      effects++;
      return { content: [{ type: 'text', text: 'simulated' }] };
    });
    server.registerTool('run_command', { inputSchema: {} }, async () => {
      throw new Error('Must never execute');
    });
    await server.connect(
      new WebSocketClientTransport({
        url: base.replace('http:', 'ws:') + '/connect',
        allowInsecure: true,
        token,
        identity: {
          device_id: id,
          platform: 'linux',
          hostname: id,
          connector_version: '1',
          capabilities: [],
        },
        log: silentLogger,
      }),
    );
    await sleep(200);
  };
  const client = async (id: string) => {
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(base + '/mcp/' + id), {
        requestInit: { headers: { Authorization: 'Bearer test-orchestrator' } },
      }),
    );
    return c;
  };
  try {
    const { cluster, token } = await admin('/clusters', {
      name: 'Training',
      owner: 'tenant-a',
      max_nodes: 2,
    });
    await connect('node-a', token);
    await connect('node-b', token);
    assert.equal((await storage.registry.get('node-a'))?.owner, 'tenant-a');
    assert.equal((await storage.registry.get('node-b'))?.cluster_id, cluster._id);
    await connect('node-over-capacity', token);
    assert.equal(await storage.registry.get('node-over-capacity'), undefined);
    const other = await admin('/clusters', { name: 'Other', owner: 'tenant-b' });
    await connect('node-a', other.token);
    assert.equal((await storage.registry.get('node-a'))?.owner, 'tenant-a');
    const c = await client('node-a');
    assert.deepEqual(
      (await c.listTools()).tools.map((t) => t.name),
      ['system_info'],
    );
    await assert.rejects(c.callTool({ name: 'run_command', arguments: {} }), /not allowed/);
    await assert.rejects(
      c.callTool({ name: 'gpu_remediate', arguments: { action: 'reboot' } }),
      /not allowed/,
    );
    await admin(
      `/clusters/${cluster._id}`,
      { remediation: 'automatic', actions: ['gpu_reset'], cooldown_seconds: 60 },
      'PUT',
    );
    await assert.rejects(
      c.callTool({ name: 'gpu_remediate', arguments: { action: 'reboot' } }),
      /not enabled/,
    );
    await c.callTool({ name: 'gpu_remediate', arguments: { action: 'gpu_reset' } });
    await assert.rejects(
      c.callTool({ name: 'gpu_remediate', arguments: { action: 'gpu_reset' } }),
      /cooldown/,
    );
    assert.equal(effects, 1);
    const rotated = await admin(`/clusters/${cluster._id}/rotate-token`, {}, 'POST');
    assert.notEqual(rotated.token, token);
    assert.equal(gateway.hub.online('node-a'), undefined);
    await connect('node-new', token);
    assert.equal(await storage.registry.get('node-new'), undefined);
    await connect('node-b', rotated.token);
    assert.ok(gateway.hub.online('node-b'));
    await admin(`/clusters/${cluster._id}`, { disabled: true }, 'PUT');
    assert.equal(gateway.hub.online('node-b'), undefined);
    await assert.rejects(c.callTool({ name: 'system_info', arguments: {} }), /disabled/);
    await c.close();
  } finally {
    await Promise.all(servers.map((s) => s.close()));
    await gateway.close();
  }
});
test('cluster reservations bound 2000-node enrollment and atomically serialize disruptive requests', async () => {
  const store = new MemoryClusters();
  const id = randomUUID();
  await store.create({
    ...clusterSchema.parse({
      name: 'large',
      max_nodes: 2000,
      remediation: 'automatic',
      actions: ['gpu_reset'],
    }),
    _id: id,
    owner: 'owner',
    token_hash: 'unused',
    created_at: new Date().toISOString(),
  });
  const admitted = await Promise.all(
    Array.from({ length: 2010 }, (_, i) => store.claimNode(id, `node-${i}`)),
  );
  assert.equal(admitted.filter(Boolean).length, 2000);
  assert.ok(await store.claimNode(id, 'node-0'));
  const reservations = await Promise.all(
    Array.from({ length: 100 }, () => store.reserveAction(id, 1000, 'gpu_reset')),
  );
  assert.equal(reservations.filter(Boolean).length, 1);
  assert.equal(await store.reserveAction(id, 1000000, 'reboot'), false);
  await store.update(id, { remediation: 'approval' });
  assert.equal(await store.reserveAction(id, 1000000, 'gpu_reset', 'automatic'), false);
});
test('cluster enrollment works through a verified TLS edge and refuses untrusted certificates', async () => {
  const { createServer } = await import('node:https');
  const { connect } = await import('node:net');
  const { readFile } = await import('node:fs/promises');
  const { WebSocket } = await import('ws');
  const cert = await readFile(new URL('./fixtures/localhost-test.crt', import.meta.url));
  const key = await readFile(new URL('./fixtures/localhost-test.key', import.meta.url));
  const storage = memoryStorage();
  const gateway = await startGateway(
    gatewayConfigSchema.parse({
      PORT: 0,
      HOST: '127.0.0.1',
      TRUST_PROXY: '1',
      GATEWAY_ADMIN_TOKEN: 'test-admin',
    }),
    { storage, log: silentLogger },
  );
  const proxy = createServer({ key, cert });
  const sockets = new Set<any>();
  proxy.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const upstream = connect(gateway.port, '127.0.0.1', () => {
      const headers = Object.entries(req.headers)
        .filter(([name]) => name !== 'x-forwarded-proto')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\nx-forwarded-proto: https\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as any).port;
  const node = new McpServer({ name: 'tls-node', version: '1' });
  node.registerTool('system_info', { inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'TLS node' }],
  }));
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/admin/clusters`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TLS cluster', owner: 'tls-owner' }),
    });
    const { token } = (await response.json()) as any;
    const untrusted = new WebSocket(`wss://127.0.0.1:${port}/connect`, 'openharness-mcp.v1');
    await new Promise<void>((resolve, reject) => {
      untrusted.once('error', () => resolve());
      untrusted.once('open', () => reject(new Error('Untrusted certificate accepted')));
    });
    class TrustedSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { ca: cert, rejectUnauthorized: true });
      }
    }
    await node.connect(
      new WebSocketClientTransport({
        url: `wss://127.0.0.1:${port}/connect`,
        token,
        WebSocketImpl: TrustedSocket as any,
        identity: {
          device_id: 'tls-node',
          platform: 'linux',
          hostname: 'tls-node',
          connector_version: '1',
          capabilities: [],
        },
        log: silentLogger,
      }),
    );
    for (let i = 0; i < 50 && !gateway.hub.online('tls-node'); i++) await sleep(100);
    assert.ok(gateway.hub.online('tls-node'));
  } finally {
    await node.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await gateway.close();
  }
});

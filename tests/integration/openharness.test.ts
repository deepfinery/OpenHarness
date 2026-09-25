import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// The Open Harness API adapter (issues #1 and #2): routing, auth, error envelope, pagination, registry,
// capability manifest, health and credential validation, against the real stack.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const oh = `${base}/openharness/v1`;
const harness = `${oh}/harnesses/openharness`;
const suffix = randomUUID().slice(0, 8);
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';

type Reply = { status: number; data: any; headers: Headers };
async function call(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    ...(init.body === undefined
      ? {}
      : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : undefined,
    headers: response.headers,
  } as Reply;
}
const session = (extra: Record<string, string> = {}) => ({ Cookie: cookie, Origin: base, ...extra });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
async function studio(path: string, method = 'GET', body?: unknown, headers = session()) {
  const r = await call(`${base}/api${path}`, { method, body, headers });
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
function assertError(r: Reply, status: number, code: string) {
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.equal(typeof r.data?.error?.message, 'string');
  assert.equal(r.data.error.code, code);
}
before(async () => {
  const status = await (await fetch(base + '/api/auth/status')).json();
  if (status.needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice('SETUP_TOKEN='.length);
    await call(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { Origin: base },
      body: { ...admin, name: 'Test Administrator', setupToken },
    });
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(admin),
  });
  assert.equal(login.status, 200, 'Could not sign in to the isolated stack');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});

test('the adapter rejects anonymous calls with the spec error envelope', async () => {
  assertError(await call(`${oh}/harnesses`), 401, 'UNAUTHORIZED');
  assertError(
    await call(`${oh}/harnesses`, { headers: bearer('oh_sk_not-a-real-key') }),
    401,
    'UNAUTHORIZED',
  );
  const unknown = await call(`${oh}/no-such-route`, { headers: session() });
  assertError(unknown, 404, 'NOT_FOUND');
});

test('the registry lists this installation as one hosted harness with limit/offset pagination', async () => {
  const list = await call(`${oh}/harnesses`, { headers: session() });
  assert.equal(list.status, 200);
  assert.equal(list.data.total, 1);
  assert.equal(list.data.limit, 20);
  assert.equal(list.data.offset, 0);
  assert.equal(list.data.has_more, false);
  const [h] = list.data.data;
  assert.equal(h.id, 'openharness');
  assert.equal(h.execution_type, 'hosted');
  assert.equal(h.status, 'active');
  assert.ok(Date.parse(h.created_at) && Date.parse(h.updated_at));
  assert.equal(Object.keys(h.capabilities).length, 11);

  const skipped = await call(`${oh}/harnesses?offset=1`, { headers: session() });
  assert.deepEqual(skipped.data.data, []);
  assert.equal(skipped.data.total, 1);
  const filtered = await call(`${oh}/harnesses?execution_type=ide`, { headers: session() });
  assert.equal(filtered.data.total, 0);
  const invalid = await call(`${oh}/harnesses?limit=0`, { headers: session() });
  assertError(invalid, 400, 'VALIDATION_ERROR');
  assert.equal(invalid.data.error.details.issues[0].path, 'limit');

  const one = await call(harness, { headers: session() });
  assert.equal(one.data.harness.id, 'openharness');
  assertError(await call(`${oh}/harnesses/someone-else`, { headers: session() }), 404, 'NOT_FOUND');
});

test('the capability manifest covers every domain and reports only what is served', async () => {
  const r = await call(`${harness}/capabilities`, { headers: session() });
  assert.equal(r.status, 200);
  assert.equal(r.data.harness_id, 'openharness');
  assert.equal(r.data.harness_name, 'OpenHarness');
  assert.match(r.data.version, /^\d+\.\d+\.\d+/);
  const domains = [
    'agents',
    'skills',
    'mcp',
    'execution',
    'sessions',
    'memory',
    'subagents',
    'files',
    'hooks',
    'planning',
    'models',
  ];
  assert.deepEqual(Object.keys(r.data.capabilities).sort(), [...domains].sort());
  for (const domain of domains) {
    const c = r.data.capabilities[domain];
    assert.equal(typeof c.supported, 'boolean');
    assert.ok(Array.isArray(c.operations) && Array.isArray(c.limitations));
    assert.equal(c.supported, c.operations.length > 0, `${domain} supported flag matches its operations`);
  }
  // A route of an unsupported domain answers 501 with the domain and operation named.
  if (!r.data.capabilities.memory.supported) {
    const memory = await call(`${harness}/agents/any-agent/memory`, { headers: session() });
    assertError(memory, 501, 'CAPABILITY_NOT_SUPPORTED');
    assert.equal(memory.data.error.domain, 'memory');
    assert.equal(memory.data.error.operation, 'memory.get');
    assert.equal(memory.data.error.details.harness_id, 'openharness');
  }
});

test('health answers anonymously without internal details, and in detail when signed in', async () => {
  const anonymous = await call(`${harness}/health`);
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.data.status, 'healthy', JSON.stringify(anonymous.data));
  assert.equal(typeof anonymous.data.latency_ms, 'number');
  const names = anonymous.data.checks.map((c: any) => c.name);
  for (const name of ['database', 'queue', 'vector_store']) assert.ok(names.includes(name), name);
  assert.ok(
    anonymous.data.checks.every(
      (c: any) => c.status === 'pass' && c.message === undefined && c.latency_ms === undefined,
    ),
  );
  const detailed = await call(`${harness}/health`, { headers: session() });
  assert.ok(detailed.data.checks.every((c: any) => typeof c.latency_ms === 'number'));
});

test('the single-harness registry is read-only', async () => {
  const register = await call(`${oh}/harnesses`, {
    method: 'POST',
    headers: session(),
    body: {
      id: 'goose',
      name: 'Goose',
      vendor: 'Block',
      description: 'x',
      execution_type: 'sdk',
      config: {},
    },
  });
  assertError(register, 501, 'CAPABILITY_NOT_SUPPORTED');
  assertError(
    await call(harness, { method: 'PATCH', headers: session(), body: { name: 'Renamed' } }),
    501,
    'CAPABILITY_NOT_SUPPORTED',
  );
  assertError(await call(harness, { method: 'DELETE', headers: session() }), 501, 'CAPABILITY_NOT_SUPPORTED');
});

test('request bodies and origins are validated like the studio API', async () => {
  const badJson = await call(`${harness}/validate-credentials`, {
    method: 'POST',
    headers: { ...session(), 'Content-Type': 'application/json' },
    body: '{"api_key":',
  });
  assertError(badJson, 400, 'INVALID_JSON');
  const foreign = await call(`${harness}/validate-credentials`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example' },
    body: { api_key: 'x' },
  });
  assertError(foreign, 403, 'FORBIDDEN');
  const noOrigin = await call(`${harness}/validate-credentials`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: { api_key: 'x' },
  });
  assertError(noOrigin, 403, 'FORBIDDEN');
  const missing = await call(`${harness}/validate-credentials`, {
    method: 'POST',
    headers: session(),
    body: {},
  });
  assertError(missing, 400, 'VALIDATION_ERROR');
});

test('workspace keys reach the adapter cross-origin; workflow keys stay limited; members cannot mint them', async () => {
  const created = await studio('/integrations/tokens', 'POST', {
    name: `Harness key ${suffix}`,
    scopes: ['harness'],
  });
  assert.match(created.token, /^oh_sk_/);
  const keys = await studio('/integrations/tokens');
  assert.deepEqual(keys.find((k: any) => k.id === created.id).scopes, ['harness']);
  const caps = await call(`${harness}/capabilities`, {
    headers: { ...bearer(created.token), Origin: 'https://app.example' },
  });
  assert.equal(caps.status, 200);
  assert.equal(caps.headers.get('access-control-allow-origin'), 'https://app.example');
  const preflight = await fetch(`${harness}/validate-credentials`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example',
      'Access-Control-Request-Method': 'PATCH',
      'Access-Control-Request-Headers': 'authorization, content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods')!, /PATCH/);
  // The key also works on the studio API with read/execute rights.
  const runs = await call(`${base}/api/runs`, { headers: bearer(created.token) });
  assert.equal(runs.status, 200);
  // A workspace-wide key cannot also be narrowed to targets.
  const narrowed = await call(`${base}/api/integrations/tokens`, {
    method: 'POST',
    headers: session(),
    body: { name: 'x', scopes: ['harness'], workflowIds: [randomUUID()] },
  });
  assert.equal(narrowed.status, 400);

  // A workflow-scoped key may read the registry but not store credentials.
  const provider = await studio('/providers', 'POST', {
    name: `OH provider ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  const workflow = await studio('/workflows', 'POST', {
    name: `OH scoped ${suffix}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'agent' },
      {
        id: 'agent',
        name: 'Agent',
        type: 'agent',
        prompt: '{{input}}',
        next: 'finish',
        config: { name: 'Agent', providerId: provider.id, systemPrompt: 'Help.' },
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
  });
  const scoped = await studio('/integrations/tokens', 'POST', {
    name: `Scoped ${suffix}`,
    workflowIds: [workflow.id],
  });
  assert.match(scoped.token, /^ao_/);
  assert.equal((await call(`${oh}/harnesses`, { headers: bearer(scoped.token) })).status, 200);
  const store = await call(`${harness}/validate-credentials`, {
    method: 'POST',
    headers: bearer(scoped.token),
    body: { api_key: 'sk-test', store: true },
  });
  assertError(store, 403, 'INSUFFICIENT_SCOPE');
  assert.equal(store.data.error.details.required_scope, 'harness');

  // Members can use the studio but cannot mint workspace-wide keys.
  const email = `oh-member-${suffix}@openharness.test`;
  await studio('/users', 'POST', {
    name: 'OH member',
    email,
    password: 'Open-harness-member-42',
    role: 'member',
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Open-harness-member-42' }),
  });
  const member = { Cookie: login.headers.get('set-cookie')!.split(';')[0], Origin: base };
  const denied = await call(`${base}/api/integrations/tokens`, {
    method: 'POST',
    headers: member,
    body: { name: 'mine', scopes: ['harness'] },
  });
  assert.equal(denied.status, 403);
});

test('credentials are validated against the default provider and stored only on request', async () => {
  const valid = await call(`${harness}/validate-credentials`, {
    method: 'POST',
    headers: session(),
    body: { api_key: 'sk-fixture' },
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.data));
  assert.deepEqual(valid.data, { valid: true, stored: false });
  const failing = await call(`${harness}/validate-credentials`, {
    method: 'POST',
    headers: session(),
    body: { api_key: 'sk-fixture', base_url: 'http://fixtures:9090/not-a-model-api' },
  });
  assert.equal(failing.status, 200);
  assert.equal(failing.data.valid, false);
  assert.equal(typeof failing.data.error, 'string');
  const stored = await call(`${harness}/validate-credentials`, {
    method: 'POST',
    headers: session(),
    body: { api_key: 'sk-fixture', store: true },
  });
  assert.deepEqual(stored.data, { valid: true, stored: true });
});

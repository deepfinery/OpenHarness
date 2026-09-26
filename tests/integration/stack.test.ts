import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let otherCookie = '';
let provider: any;
let connection: any;
let agent: any;
let workflow: any;
let knowledge: any;
let doc: any;
const suffix = randomUUID().slice(0, 6);
async function request(
  path: string,
  {
    method = 'GET',
    body,
    auth = cookie,
    headers = {},
  }: { method?: string; body?: unknown; auth?: string; headers?: Record<string, string> } = {},
) {
  const r = await fetch(`${base}/api${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(auth ? { Cookie: auth } : {}),
      Origin: base,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}
async function ok(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await request(path, { method, body });
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function waitRun(id: string, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await ok(`/runs/${id}`);
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Run ${id} did not finish`);
}
before(async () => {
  const config = Object.fromEntries(
    (await readFile('.env', 'utf8'))
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  const status = await request('/auth/status', { auth: '' });
  if (status.data.needsSetup) {
    const result = await request('/auth/setup', {
      auth: '',
      method: 'POST',
      body: { ...admin, name: 'Test Administrator', setupToken: config.SETUP_TOKEN },
    });
    assert.equal(result.status, 201);
    cookie = result.headers.get('set-cookie')!.split(';')[0];
  } else {
    const result = await request('/auth/login', { auth: '', method: 'POST', body: admin });
    assert.equal(result.status, 200);
    cookie = result.headers.get('set-cookie')!.split(';')[0];
  }
});
test('local auth, CSRF protections and authenticated resource boundaries', async () => {
  assert.equal((await request('/agents', { auth: '' })).status, 401);
  assert.equal(
    (
      await request('/auth/login', {
        auth: '',
        method: 'POST',
        body: { ...admin, password: 'an-invalid-password' },
      })
    ).status,
    401,
  );
  assert.equal(
    (await request('/agents', { method: 'POST', body: {}, headers: { Origin: 'https://untrusted.example' } }))
      .status,
    403,
  );
  assert.equal((await ok('/auth/me')).email, admin.email);
  assert.equal(
    (
      await request('/auth/setup', {
        method: 'POST',
        body: { ...admin, name: 'Second Admin', setupToken: 'wrong' },
      })
    ).status,
    403,
  );
});
test('provider secrets are write-only and private metadata addresses are blocked', async () => {
  provider = await ok('/providers', {
    name: `Model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
    apiKey: 'model-secret-for-tests',
  });
  assert.equal(provider.hasApiKey, true);
  assert.equal(JSON.stringify(provider).includes('model-secret-for-tests'), false);
  assert.equal(JSON.stringify(await ok('/providers')).includes('model-secret-for-tests'), false);
  const r = await request('/providers', {
    method: 'POST',
    body: { name: 'Metadata', kind: 'openai-compatible', baseUrl: 'http://169.254.169.254', model: 'bad' },
  });
  assert.equal(r.status, 400);
  assert.match((await ok(`/providers/${provider.id}/test`, {})).text, /Connected/);
});
test('Streamable HTTP MCP token authentication and real tool discovery', async () => {
  connection = await ok('/connections', {
    name: `MCP tools ${suffix}`,
    url: 'http://fixtures:9090/token-mcp',
    transport: 'http',
    authType: 'token',
    token: 'test-mcp-secret',
  });
  assert.equal(connection.hasToken, true);
  assert.equal(JSON.stringify(connection).includes('test-mcp-secret'), false);
  const tools = await ok(`/connections/${connection.id}/discover`, {});
  assert.deepEqual(tools.map((t: any) => t.name).sort(), [
    'bigdata',
    'calculate',
    'fail',
    'lookup',
    'strict',
  ]);
  assert.equal(tools.find((t: any) => t.name === 'lookup').inputSchema.required.includes('query'), true);
});
test('legacy SSE servers can expose tools through the same connector', async () => {
  const c = await ok('/connections', {
    name: `SSE ${suffix}`,
    url: 'http://fixtures:9090/sse',
    transport: 'sse',
  });
  assert.equal((await ok(`/connections/${c.id}/discover`, {})).length, 5);
});
test('MCP OAuth discovery, registration, PKCE, state binding and token refresh', async () => {
  const c = await ok('/connections', {
    name: `OAuth ${suffix}`,
    url: 'http://fixtures:9090/oauth-mcp',
    authType: 'oauth',
    oauthScope: 'tools',
  });
  const start = await ok(`/connections/${c.id}/oauth`, {});
  assert.ok(start.authorizationUrl);
  const authorization = new URL(start.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const authorize = await fetch(`${fixture}${authorization.pathname}${authorization.search}`, {
    redirect: 'manual',
  });
  assert.equal(authorize.status, 302);
  const callback = new URL(authorize.headers.get('location')!);
  const result = await request(callback.pathname.replace('/api', '') + callback.search);
  assert.equal(result.status, 302, JSON.stringify(result.data));
  assert.equal((await ok(`/connections/${c.id}`)).authorized, true);
  assert.equal((await ok(`/connections/${c.id}/discover`, {})).length, 5);
  assert.equal(
    (await request(callback.pathname.replace('/api', '') + callback.search)).status,
    400,
    'state cannot be replayed',
  );
  await fetch(`${fixture}/expire-token`, { method: 'POST' });
  assert.equal((await ok(`/connections/${c.id}/discover`, {})).length, 5);
  const stats = (await (await fetch(`${fixture}/stats`)).json()) as any;
  assert.ok(stats.refreshes >= 1);
});
test('agent uses only its selected MCP tools through a queued runner', async () => {
  agent = await ok('/agents', {
    name: `Research assistant ${suffix}`,
    description: 'Integration fixture',
    providerId: provider.id,
    systemPrompt: 'Use tools to answer.',
    connections: [{ connectionId: connection.id, tools: ['lookup'] }],
  });
  const run = await ok('/runs', { agentId: agent.id, input: 'Please use tool to look up information.' });
  const result = await waitRun(run.id);
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /MCP lookup/);
  assert.ok(result.events.some((e: any) => e.type === 'tool_completed'));
  assert.ok(result.events.some((e: any) => e.type === 'model'));
  assert.equal(JSON.stringify(result).includes('test-mcp-secret'), false);
});
test('agent with multiple MCP servers keeps names unique and tool permissions explicit', async () => {
  const second = await ok('/connections', {
    name: `Second tools ${suffix}`,
    url: 'http://fixtures:9090/mcp',
  });
  await ok(`/connections/${second.id}/discover`, {});
  const a = await ok('/agents', {
    ...agent,
    name: `Multiple tools ${suffix}`,
    connections: [
      { connectionId: connection.id, tools: ['lookup'] },
      { connectionId: second.id, tools: ['lookup'] },
    ],
  });
  const r = await waitRun((await ok('/runs', { agentId: a.id, input: 'use tool' })).id);
  assert.equal(r.status, 'succeeded', r.error);
  assert.equal(
    (
      await request('/agents', {
        method: 'POST',
        body: { ...agent, connections: [{ connectionId: connection.id, tools: ['unlisted_tool'] }] },
      })
    ).status,
    400,
  );
});
test('different LLM providers execute real tool-call round trips through their adapters', async () => {
  for (const kind of ['anthropic', 'gemini', 'ollama']) {
    const p = await ok('/providers', {
      name: `${kind} ${suffix}`,
      kind,
      baseUrl: `http://fixtures:9090${kind === 'anthropic' ? '/v1' : kind === 'gemini' ? '/v1beta' : ''}`,
      model: 'test-model',
      apiKey: 'test-model-key',
    });
    const a = await ok('/agents', { ...agent, name: `${kind} agent ${suffix}`, providerId: p.id });
    const run = await waitRun((await ok('/runs', { agentId: a.id, input: 'use tool' })).id);
    assert.equal(run.status, 'succeeded', `${kind}: ${run.error}`);
    assert.match(run.output, /Tool completed/);
  }
});
test('workflow branches and parallel agents persist their outputs and traces', async () => {
  workflow = await ok('/workflows', {
    name: `Research flow ${suffix}`,
    startAt: 'check',
    nodes: [
      {
        id: 'check',
        name: 'Check input',
        type: 'condition',
        value: '{{input}}',
        operator: 'contains',
        compare: 'run',
        onTrue: 'team',
        onFalse: 'decline',
      },
      {
        id: 'team',
        name: 'Research team',
        type: 'parallel',
        agentIds: [agent.id, agent.id],
        prompt: '{{input}}',
        next: 'answer',
      },
      { id: 'answer', name: 'Answer', type: 'output', template: '{{steps.team}}' },
      { id: 'decline', name: 'Decline', type: 'output', template: 'No work requested.' },
    ],
  });
  const run = await waitRun((await ok('/runs', { workflowId: workflow.id, input: 'run a short task' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(run.outputs.team.length, 2);
  assert.equal(run.events.filter((e: any) => e.type === 'node_completed').length, 3);
  const other = await waitRun((await ok('/runs', { workflowId: workflow.id, input: 'skip' })).id);
  assert.equal(other.output, 'No work requested.');
});
test('explicit MCP tool steps use typed bindings and report failures without claiming success', async () => {
  const flow = await ok('/workflows', {
    name: `Tool flow ${suffix}`,
    startAt: 'sum',
    nodes: [
      {
        id: 'sum',
        name: 'Sum',
        type: 'tool',
        connectionId: connection.id,
        tool: 'calculate',
        arguments: { a: 7, b: 5 },
        next: 'answer',
      },
      { id: 'answer', name: 'Answer', type: 'output', template: 'Total: {{steps.sum.sum}}' },
    ],
  });
  assert.equal(
    (await waitRun((await ok('/runs', { workflowId: flow.id, input: 'calculate' })).id)).output,
    'Total: 12',
  );
  const bad = await ok('/workflows', {
    name: `Failing tool ${suffix}`,
    startAt: 'fail',
    nodes: [
      { id: 'fail', name: 'Fail', type: 'tool', connectionId: connection.id, tool: 'fail', arguments: {} },
    ],
  });
  const run = await waitRun((await ok('/runs', { workflowId: bad.id, input: 'fail' })).id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Intentional fixture failure/);
});
test('a workflow tool step with arguments outside the MCP schema fails locally with a clear message', async () => {
  const flow = await ok('/workflows', {
    name: `Invalid arguments ${suffix}`,
    startAt: 'sum',
    nodes: [
      {
        id: 'sum',
        name: 'Sum',
        type: 'tool',
        connectionId: connection.id,
        tool: 'calculate',
        arguments: { a: 7 },
      },
    ],
  });
  const run = await waitRun((await ok('/runs', { workflowId: flow.id, input: 'calculate' })).id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Invalid arguments/);
  assert.match(run.error, /\bb\b/);
  assert.equal(
    run.events.some((e: any) => e.type === 'tool_started'),
    false,
  );
});
test('an agent recovers from an out-of-schema tool call by retrying with corrected arguments', async () => {
  const a = await ok('/agents', {
    ...agent,
    name: `Strict retry agent ${suffix}`,
    connections: [{ connectionId: connection.id, tools: ['strict'] }],
  });
  const run = await waitRun((await ok('/runs', { agentId: a.id, input: 'use strict tool' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /strict ok: fast/);
  const errorEvent = run.events.find((e: any) => e.type === 'tool_error');
  assert.ok(errorEvent, 'expected a tool_error event for the first, invalid call');
  assert.match(errorEvent.data.result, /Invalid arguments/);
  assert.match(errorEvent.data.result, /mode/);
  assert.ok(run.events.some((e: any) => e.type === 'tool_completed'));
});
test('idempotency protects duplicate API submissions and rejects key reuse with a different payload', async () => {
  const key = `integration-${randomUUID()}`;
  const body = { agentId: agent.id, input: 'A normal question' };
  const first = await request('/runs', { method: 'POST', body, headers: { 'Idempotency-Key': key } });
  const second = await request('/runs', { method: 'POST', body, headers: { 'Idempotency-Key': key } });
  assert.equal(first.status, 202);
  assert.equal(first.data.id, second.data.id);
  assert.equal(
    (
      await request('/runs', {
        method: 'POST',
        body: { ...body, input: 'Different question' },
        headers: { 'Idempotency-Key': key },
      })
    ).status,
    409,
  );
  assert.equal((await waitRun(first.data.id)).status, 'succeeded');
});
test('file upload, background indexing, Weaviate retrieval and grounded agent response', async () => {
  knowledge = await ok('/knowledge', { name: `Runbook ${suffix}`, providerId: provider.id });
  const file = new FormData();
  file.append(
    'file',
    new Blob([
      'The Aurora deployment checklist requires three successful health checks before releasing traffic.\n\nA release owner verifies the queue, database, and API before approving deployment.',
    ]),
    'runbook.md',
  );
  doc = await ok(`/knowledge/${knowledge.id}/documents`, file);
  const end = Date.now() + 60000;
  let found;
  while (Date.now() < end) {
    found = (await ok(`/knowledge/${knowledge.id}/documents`)).find((d: any) => d.id === doc.id);
    if (['ready', 'failed'].includes(found?.status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(found?.status, 'ready', found?.error);
  assert.ok(found.chunks >= 1);
  const passages = await ok(`/knowledge/${knowledge.id}/search`, {
    query: 'Aurora deployment health checks',
  });
  assert.ok(passages.length);
  assert.match(passages[0].content, /three successful health checks/);
  const grounded = await ok('/agents', {
    ...agent,
    name: `Grounded assistant ${suffix}`,
    knowledgeBaseIds: [knowledge.id],
    connections: [],
  });
  const run = await waitRun(
    (await ok('/runs', { agentId: grounded.id, input: 'What are the Aurora deployment requirements?' })).id,
  );
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /three successful health checks/);
  assert.ok(run.events.some((e: any) => e.type === 'knowledge'));
  const download = await request(`/documents/${doc.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.data, /Aurora/);
  assert.equal(
    (
      await request(`/providers/${provider.id}`, {
        method: 'PUT',
        body: { ...provider, embeddingModel: 'different-model' },
      })
    ).status,
    409,
  );
});
test('internal accounts cannot read or bind another account’s data, files or runs', async () => {
  const email = `member-${suffix}@openharness.test`;
  const password = 'Another-test-password-42';
  const user = await ok('/users', { name: 'Other User', email, password, workspace: 'new' });
  const loggedIn = await request('/auth/login', { method: 'POST', body: { email, password }, auth: '' });
  otherCookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
  assert.deepEqual((await request('/agents', { auth: otherCookie })).data, []);
  assert.equal((await request(`/agents/${agent.id}`, { auth: otherCookie })).status, 404);
  assert.equal((await request(`/documents/${doc.id}/download`, { auth: otherCookie })).status, 404);
  assert.equal((await request('/users', { auth: otherCookie })).data.length, 1);
  assert.equal(
    (await request('/agents', { auth: otherCookie, method: 'POST', body: { ...agent, name: 'Borrowed' } }))
      .status,
    400,
  );
  assert.equal(
    (
      await request('/runs', {
        auth: otherCookie,
        method: 'POST',
        body: { agentId: agent.id, input: 'steal data' },
      })
    ).status,
    400,
  );
});
test('API tokens are target-scoped, cannot manage resources, and revoke immediately', async () => {
  const token = await ok('/integrations/tokens', {
    name: `API client ${suffix}`,
    agentIds: [agent.id],
    scopes: ['read', 'execute'],
  });
  const headers = { Authorization: `Bearer ${token.token}` };
  assert.equal((await request('/providers', { auth: '', headers })).status, 403);
  assert.equal(
    (
      await request('/runs', {
        auth: '',
        method: 'POST',
        headers,
        body: { workflowId: workflow.id, input: 'not allowed' },
      })
    ).status,
    403,
  );
  const r = await request('/runs', {
    auth: '',
    method: 'POST',
    headers,
    body: { agentId: agent.id, input: 'API request' },
  });
  assert.equal(r.status, 202);
  await waitRun(r.data.id);
  assert.equal((await request(`/runs/${r.data.id}`, { auth: '', headers })).status, 200);
  await ok(`/integrations/tokens/${token.id}`, undefined, 'DELETE');
  assert.equal((await request(`/runs/${r.data.id}`, { auth: '', headers })).status, 401);
});
test('iframe access is restricted, does not reveal internal traces, and can be revoked', async () => {
  const embed = await ok('/integrations/embeds', {
    name: 'Embedded assistant',
    agentId: agent.id,
    origins: ['https://example.com'],
    expiresDays: 1,
  });
  const url = new URL(embed.url);
  const headers = { Authorization: `Embed ${url.hash.slice(1)}` };
  const page = await fetch(base + url.pathname);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'self' https:\/\/example.com/);
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.equal((await request(`/embed/${embed.id}`, { auth: '' })).status, 401);
  const r = await request(`/embed/${embed.id}/runs`, {
    auth: '',
    headers,
    method: 'POST',
    body: { input: 'Hello from iframe' },
  });
  assert.equal(r.status, 202);
  await waitRun(r.data.id);
  const result = await request(`/embed/${embed.id}/runs/${r.data.id}`, { auth: '', headers });
  assert.equal(result.status, 200);
  assert.match(result.data.output, /iframe/);
  assert.equal(result.data.events, undefined);
  assert.equal(result.data.snapshot, undefined);
  await ok(`/integrations/embeds/${embed.id}`, undefined, 'DELETE');
  assert.equal((await request(`/embed/${embed.id}`, { auth: '', headers })).status, 401);
});
test('cancellation stops a running model request and does not overwrite the terminal state', async () => {
  const run = await ok('/runs', { agentId: agent.id, input: 'delay-model' });
  for (let i = 0; i < 20; i++) {
    const r = await ok(`/runs/${run.id}`);
    if (r.status === 'running') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await ok(`/runs/${run.id}/cancel`, {});
  const result = await waitRun(run.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.output, undefined);
});
test('document deletion removes both filesystem and retrieval visibility', async () => {
  await ok(`/documents/${doc.id}`, undefined, 'DELETE');
  const remaining = await ok(`/knowledge/${knowledge.id}/search`, { query: 'Aurora' });
  assert.ok(
    !remaining.some((hit: any) => hit.documentId === doc.id),
    'the deleted source disappears; separate notebook experiment records can remain',
  );
  for (let i = 0; i < 30; i++) {
    if (!(await ok(`/knowledge/${knowledge.id}/documents`)).some((d: any) => d.id === doc.id)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(
    (await ok(`/knowledge/${knowledge.id}/documents`)).some((d: any) => d.id === doc.id),
    false,
  );
  assert.equal((await request(`/documents/${doc.id}/download`)).status, 404);
});

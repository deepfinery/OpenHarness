import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeStarter } from '../../packages/core/src/starters.js';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const suffix = randomUUID().slice(0, 8);
let cookie = '',
  memberCookie = '',
  outsiderCookie = '';
let provider: any, connection: any, workflow: any, member: any, outsider: any;
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  auth = cookie,
  extra: Record<string, string> = {},
) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      Origin: base,
      ...(auth ? { Cookie: auth } : {}),
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined, headers: response.headers };
}
async function ok(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  auth = cookie,
  headers: Record<string, string> = {},
) {
  const r = await request(path, method, body, auth, headers);
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function waitRun(id: string) {
  for (let i = 0; i < 120; i++) {
    const run = await ok(`/runs/${id}`);
    if (!['running', 'queued'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Run did not finish');
}
async function account(workspace: 'current' | 'new') {
  const credentials = { email: `${workspace}-${suffix}@agentic.test`, password: 'Harness-test-password-42' };
  const user = await ok('/users', { ...credentials, workspace, name: `${workspace} teammate` });
  const response = await request('/auth/login', 'POST', credentials, '');
  assert.equal(response.status, 200);
  return { user, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
before(async () => {
  const login = await request(
    '/auth/login',
    'POST',
    { email: 'admin@agentic.test', password: 'Integration-test-password-42' },
    '',
  );
  assert.equal(login.status, 200, 'Run stack.test.ts first to bootstrap the isolated stack');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  provider = await ok('/providers', {
    name: `Harness model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  connection = await ok('/connections', { name: `Harness MCP ${suffix}`, url: 'http://fixtures:9090/mcp' });
  await ok(`/connections/${connection.id}/discover`, {});
});
test('MCP template compiles resource attachments into an immutable queued agent snapshot', async () => {
  workflow = await ok(
    '/workflows',
    makeStarter({
      kind: 'mcp',
      providerId: provider.id,
      connectionId: connection.id,
      tools: ['lookup'],
      name: `Harness ${suffix}`,
    }),
  );
  const submitted = await ok('/runs', { workflowId: workflow.id, input: 'Please use tool' });
  const run = await waitRun(submitted.id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /MCP lookup/);
  assert.deepEqual(
    run.events.filter((e: any) => e.type === 'node_started').map((e: any) => e.nodeId),
    ['start', 'assistant', 'finish'],
  );
  assert.ok(run.events.some((e: any) => e.type === 'tool_completed' && e.nodeId === 'assistant'));
  // Run responses deliberately omit internal snapshots; behavior and traces verify the grants.
  const invalid = structuredClone(workflow);
  invalid.resources[0].tools = ['not_discovered'];
  assert.equal((await request('/workflows', 'POST', invalid)).status, 400);
  assert.equal(
    (await request(`/connections/${connection.id}`, 'DELETE')).status,
    409,
    'resource dependency prevents deleting an attached server',
  );
});
test('MCP supports custom authentication headers while refusing unsafe transport headers', async () => {
  const c = await ok('/connections', {
    name: 'Custom authentication',
    url: 'http://fixtures:9090/custom-mcp',
    authType: 'token',
    tokenHeader: 'X-Custom-Token',
    token: 'test-custom-mcp-value',
  });
  assert.equal((await ok(`/connections/${c.id}/discover`, {})).length, 4);
  assert.equal((await request('/connections', 'POST', { ...c, tokenHeader: 'Host' })).status, 400);
});
test('teammates share resources and executions; workspace boundaries and concurrent edits remain enforced', async () => {
  const shared = await account('current');
  member = shared.user;
  memberCookie = shared.cookie;
  const isolated = await account('new');
  outsider = isolated.user;
  outsiderCookie = isolated.cookie;
  const me = await ok('/auth/me');
  assert.equal(member.tenantId, me.tenantId);
  assert.notEqual(outsider.tenantId, me.tenantId);
  assert.equal((await ok(`/workflows/${workflow.id}`, undefined, 'GET', memberCookie)).id, workflow.id);
  assert.ok((await ok('/providers', undefined, 'GET', memberCookie)).some((p: any) => p.id === provider.id));
  assert.equal((await request('/users', 'GET', undefined, memberCookie)).status, 403);
  const changed = await ok(
    `/workflows/${workflow.id}`,
    { ...workflow, description: 'Updated by teammate' },
    'PUT',
    memberCookie,
    { 'If-Match': String(workflow.revision) },
  );
  assert.equal(changed.revision, workflow.revision + 1);
  assert.equal(
    (
      await request(`/workflows/${workflow.id}`, 'PUT', workflow, cookie, {
        'If-Match': String(workflow.revision),
      })
    ).status,
    409,
  );
  workflow = changed;
  const run = await waitRun(
    (await ok('/runs', { workflowId: workflow.id, input: 'Shared tenant run' }, 'POST', memberCookie)).id,
  );
  assert.equal(run.initiatedBy, member.id);
  assert.equal(run.status, 'succeeded');
  assert.equal((await request(`/runs/${run.id}`, 'GET', undefined, outsiderCookie)).status, 404);
  assert.equal((await request(`/workflows/${workflow.id}`, 'GET', undefined, outsiderCookie)).status, 404);
  assert.equal((await request('/workflows', 'POST', workflow, outsiderCookie)).status, 400);
  assert.equal(
    (await request(`/users/${member.id}`, 'PATCH', { enabled: false }, outsiderCookie)).status,
    404,
  );
  assert.deepEqual(
    (await ok('/users', undefined, 'GET', outsiderCookie)).map((u: any) => u.id),
    [outsider.id],
  );
  assert.equal(
    (
      await request('/providers', 'POST', provider, cookie, {
        Origin: 'https://foreign.example',
        Authorization: 'Basic unrelated',
      })
    ).status,
    403,
  );
});
test('knowledge research template indexes files and supplies retrieved context to its attached agent', async () => {
  const kb = await ok('/knowledge', { name: `Harness research ${suffix}`, providerId: provider.id });
  const upload = new FormData();
  upload.append(
    'file',
    new Blob([
      'The Juniper research protocol requires four independent observations before approving a finding.',
    ]),
    'research-protocol.md',
  );
  const doc = await ok(`/knowledge/${kb.id}/documents`, upload);
  let indexed;
  for (let i = 0; i < 60; i++) {
    indexed = (await ok(`/knowledge/${kb.id}/documents`)).find((d: any) => d.id === doc.id);
    if (['ready', 'failed'].includes(indexed?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(indexed?.status, 'ready', indexed?.error);
  const flow = await ok(
    '/workflows',
    makeStarter({ kind: 'research', providerId: provider.id, knowledgeBaseId: kb.id }),
  );
  const run = await waitRun(
    (await ok('/runs', { workflowId: flow.id, input: 'What does the Juniper protocol require?' })).id,
  );
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /four independent observations/);
  assert.ok(run.events.some((e: any) => e.type === 'knowledge' && e.nodeId === 'assistant'));
});
test('webhooks enqueue typed payloads, deduplicate retries, scope polling, and revoke immediately', async () => {
  const flow = makeStarter({ kind: 'blank' });
  (flow.nodes.find((n) => n.type === 'finish') as any).template = 'Event {{payload.event.id}}: {{input}}';
  const target = await ok('/workflows', flow);
  const hook = await ok('/integrations/webhooks', {
    name: 'Test event',
    workflowId: target.id,
    inputPath: 'event.message',
  });
  const headers = { Authorization: `Bearer ${hook.secret}`, 'Idempotency-Key': `event-${suffix}` };
  const payload = { event: { id: 7, message: 'Run from an external service' } };
  const first = await ok(`/hooks/${hook.id}`, payload, 'POST', '', headers);
  const repeated = await ok(`/hooks/${hook.id}`, payload, 'POST', '', headers);
  assert.equal(first.id, repeated.id);
  const run = await waitRun(first.id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(run.output, 'Event 7: Run from an external service');
  assert.equal(run.trigger, 'webhook');
  const result = await ok(`/hooks/${hook.id}/runs/${run.id}`, undefined, 'GET', '', headers);
  assert.equal(result.events, undefined);
  assert.equal(result.output, run.output);
  assert.equal(
    (await request(`/hooks/${hook.id}`, 'POST', { event: { id: 8, message: 'Changed' } }, '', headers))
      .status,
    409,
  );
  assert.equal((await request(`/hooks/${hook.id}`, 'POST', payload, '')).status, 401);
  const other = await ok('/integrations/webhooks', { name: 'Other event', workflowId: target.id });
  assert.equal(
    (
      await request(`/hooks/${other.id}/runs/${run.id}`, 'GET', undefined, '', {
        Authorization: `Bearer ${other.secret}`,
      })
    ).status,
    404,
  );
  assert.equal((await ok('/integrations/webhooks', undefined, 'GET', outsiderCookie)).length, 0);
  await ok(`/integrations/webhooks/${hook.id}`, undefined, 'DELETE');
  assert.equal((await request(`/hooks/${hook.id}`, 'POST', payload, '', headers)).status, 401);
});
test('conversational API retains server history and serializes turns without exposing conversations to teammates', async () => {
  const first = await ok('/chat', {
    workflowId: workflow.id,
    message: 'Remember the project code is Juniper',
  });
  assert.equal((await waitRun(first.id)).status, 'succeeded');
  const second = await ok('/chat', { conversationId: first.conversationId, message: 'recall conversation' });
  const answer = await waitRun(second.id);
  assert.match(answer.output, /project code is Juniper/);
  assert.equal((await ok(`/conversations/${first.conversationId}`)).messages.length, 4);
  assert.equal(
    (await request(`/conversations/${first.conversationId}`, 'GET', undefined, memberCookie)).status,
    404,
  );
  assert.equal(
    (
      await request(
        '/chat',
        'POST',
        { conversationId: first.conversationId, message: 'steal history' },
        memberCookie,
      )
    ).status,
    404,
  );
  const slow = await ok('/chat', { conversationId: first.conversationId, message: 'delay-model' });
  assert.equal(
    (await request('/chat', 'POST', { conversationId: first.conversationId, message: 'racing turn' })).status,
    409,
  );
  await ok(`/runs/${slow.id}/cancel`, {});
  assert.equal((await waitRun(slow.id)).status, 'cancelled');
  const resumed = await ok('/chat', { conversationId: first.conversationId, message: 'recall conversation' });
  const result = await waitRun(resumed.id);
  assert.equal(result.status, 'succeeded');
  assert.doesNotMatch(result.output, /delay-model|racing turn/);
});
test('teammate API keys work across origins with target scopes and are invalidated when the creator is disabled', async () => {
  const token = await ok(
    '/integrations/tokens',
    { name: 'Teammate client', workflowIds: [workflow.id], scopes: ['read', 'execute'] },
    'POST',
    memberCookie,
  );
  const headers = { Authorization: `Bearer ${token.token}`, Origin: 'https://client.example' };
  const response = await request(
    '/chat',
    'POST',
    { workflowId: workflow.id, message: 'API chat' },
    '',
    headers,
  );
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://client.example');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal((await waitRun(response.data.id)).status, 'succeeded');
  const preflight = await request('/chat', 'OPTIONS', undefined, '', {
    Origin: 'https://client.example',
    'Access-Control-Request-Headers': 'authorization,content-type',
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    (
      await request('/chat', 'POST', { workflowId: workflow.id, message: 'bad bearer' }, cookie, {
        Authorization: 'Bearer invalid',
        Origin: 'https://client.example',
      })
    ).status,
    401,
  );
  await ok(`/users/${member.id}`, { enabled: false }, 'PATCH');
  assert.equal((await request(`/runs/${response.data.id}`, 'GET', undefined, '', headers)).status, 401);
  assert.equal((await request('/workflows', 'GET', undefined, memberCookie)).status, 401);
});
test('an explicit harness loop fails at its step budget instead of running indefinitely', async () => {
  const w = makeStarter({ kind: 'blank' });
  w.maxSteps = 4;
  (w.nodes[0] as any).next = 'loop';
  w.nodes.push({
    id: 'loop',
    type: 'condition',
    name: 'Loop',
    value: '{{input}}',
    operator: 'equals',
    compare: 'again',
    onTrue: 'loop',
    onFalse: 'finish',
  });
  const saved = await ok('/workflows', w);
  const run = await waitRun((await ok('/runs', { workflowId: saved.id, input: 'again' })).id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /step budget exceeded/);
  assert.equal(run.events.filter((e: any) => e.type === 'node_started').length, 4);
});

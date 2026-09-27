import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
let cookie = '';
async function ok(path: string, body?: unknown) {
  const response = await fetch(base + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
  return result;
}
async function run(agentId: string, input: string, history: unknown[] = []) {
  const started = await ok('/runs', { agentId, input, history });
  for (let i = 0; i < 120; i++) {
    const result = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Run did not finish');
}
async function agent(
  model: string,
  settings: Record<string, unknown> = {},
  providerSettings: Record<string, unknown> = {},
) {
  const provider = await ok('/providers', {
    name: 'Lifecycle regression provider',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model,
    ...providerSettings,
  });
  const agent = await ok('/agents', {
    name: 'Lifecycle regression agent',
    providerId: provider.id,
    systemPrompt: 'Research carefully. Preserve source attribution and uncertainty.',
    maxTurns: 6,
    tokenBudget: 200000,
    ...settings,
  });
  return { agent, provider };
}
before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Test administrator', setupToken });
  }
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  // A separate tenant keeps this regression suite within the normal per-tenant submission limits.
  const isolated = {
    email: `notebook-regression-${randomUUID()}@openharness.test`,
    password: credentials.password,
  };
  await ok('/users', { ...isolated, name: 'Regression user', workspace: 'new' });
  const session = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(isolated),
  });
  assert.equal(session.status, 200);
  cookie = session.headers.get('set-cookie')!.split(';')[0];
});

test('greeting does not open tools or restart old work even with maximum effort and a loop pattern', async () => {
  const connection = await ok('/connections', { name: 'Greeting tools', url: 'http://fixtures:9090/mcp' });
  await ok(`/connections/${connection.id}/discover`, {});
  const { agent: a } = await agent('test-chat', {
    pattern: 'loop',
    effort: 'max',
    tokenBudget: 2000000,
    connections: [{ connectionId: connection.id, tools: ['lookup'] }],
    delegation: { enabled: true },
  });
  const result = await run(a.id, 'hey', [
    { role: 'user', content: 'Run a full vulnerability audit on vm4. Please use tool.' },
    { role: 'assistant', content: 'The prior audit has unfinished checks.' },
  ]);
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Hello! What would you like help with/);
  assert.equal(
    result.events.filter((e: any) => ['model', 'tool_started', 'subagent_started'].includes(e.type)).length,
    0,
  );
});

test('reflection routes only the critique to the selected judge and shares its usage', async () => {
  const { provider: judge } = await agent('test-judge');
  for (const judgeProviderId of [judge.id, undefined]) {
    const { agent: a } = await agent('test-worker', {
      pattern: 'reflection',
      patternConfig: { judgeProviderId },
    });
    const result = await run(a.id, 'Explain a sorting algorithm');
    assert.equal(result.status, 'succeeded', result.error);
    const models = result.events.filter((e: any) => e.type === 'model');
    assert.deepEqual(
      models.map((e: any) => e.data.model),
      ['test-worker', judgeProviderId ? 'test-judge' : 'test-worker', 'test-worker'],
    );
    assert.ok(models[2].data.tokensUsed > models[1].data.tokensUsed);
    assert.equal(result.tokensUsed, models[2].data.tokensUsed);
  }
});

test('expanding a conversation reuses prior evidence without rewriting the completed finding', async () => {
  const { agent: a } = await agent('test-chat');
  const first = await ok('/chat', { agentId: a.id, message: 'task notebook roundtrip' });
  async function finish(id: string): Promise<any> {
    for (let i = 0; i < 120; i++) {
      const r = await ok(`/runs/${id}`);
      if (!['queued', 'running'].includes(r.status)) return r;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Conversation did not finish');
  }
  assert.equal((await finish(first.id)).status, 'succeeded');
  const followup = await ok('/chat', {
    conversationId: first.conversationId,
    message: 'expand previous evidence',
  });
  const result = await finish(followup.id);
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Expanded without repeating: immediate evidence/);
  assert.deepEqual(result.sourceTaskIds, [first.id]);
  assert.equal((await ok(`/runs/${followup.id}/memory`)).notes.length, 0, 'no duplicate completed work');
});

test('pattern passes follow configured iteration limits independently of a context window', async () => {
  const { agent: a } = await agent(
    'test-chat',
    { pattern: 'loop', patternConfig: { iterations: 6 }, maxTurns: 1, tokenBudget: 2000000 },
    { contextWindow: 8192 },
  );
  const result = await run(a.id, 'exhaust analysis turns');
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.events.filter((e: any) => e.type === 'iteration').length, 6);
  assert.ok(result.events.some((e: any) => e.type === 'loop_limit'));
  assert.ok(result.events.some((e: any) => e.type === 'model' && e.message.startsWith('Final answer')));
  assert.ok(result.tokensUsed < 2000000);
});

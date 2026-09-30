import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let providerId = '';
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
async function run(settings: Record<string, unknown>, input: string, history: unknown[] = []) {
  const agent = await ok('/agents', {
    name: 'Identity probe',
    providerId,
    systemPrompt: 'Research accurately.',
    tokenBudget: 200000,
    ...settings,
  });
  const started = await ok('/runs', { agentId: agent.id, input, history });
  for (let i = 0; i < 160; i++) {
    const result = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(result.status)) {
      assert.equal(result.status, 'succeeded', result.error);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Run did not finish');
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
  async function login(credentials: { email: string; password: string }) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  }
  await login(credentials);
  const isolated = { email: `identity-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Identity regression', workspace: 'new' });
  await login(isolated);
});

for (const streaming of [true, false]) {
  test(`runtime supplies configured identity despite stale history and records actual response metadata (streaming=${streaming})`, async () => {
    providerId = (
      await ok('/providers', {
        name: 'Identity fixture',
        kind: 'openai-compatible',
        baseUrl: 'http://fixtures:9090/v1',
        model: 'test-identity',
        streaming,
        contextWindow: 8192,
        maxOutputTokens: 1024,
      })
    ).id;
    const result = await run({}, 'What model are you?', [
      { role: 'user', content: 'What model are you?' },
      { role: 'assistant', content: 'I am Claude, made by Anthropic. '.repeat(1000) },
    ]);
    assert.ok(result.events.some((e: any) => e.type === 'context_compacted'));
    const output = JSON.parse(result.output);
    assert.deepEqual(output.identities, ['test-identity']);
    assert.equal(output.policy, true);
    assert.equal(output.requested, 'test-identity');
    const requests = result.events.filter((e: any) => e.type === 'model_request');
    const responses = result.events.filter((e: any) => e.type === 'model_response');
    assert.equal(requests.length, 1);
    assert.equal(responses.length, 1);
    assert.equal(requests[0].data.providerId, providerId);
    assert.equal(requests[0].data.endpoint, 'http://fixtures:9090/v1');
    assert.equal(responses[0].data.requestedModel, 'test-identity');
    assert.equal(responses[0].data.reportedModel, 'test-identity-served');
    assert.equal(responses[0].data.responseId, 'identity-response');
    assert.equal(responses[0].data.modelMatches, false);
  });
}

test('reflection judge gets its own configured identity instead of inheriting the worker identity', async () => {
  const judge = await ok('/providers', {
    name: 'Identity judge',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-identity-judge',
    contextWindow: 8192,
    maxOutputTokens: 1024,
  });
  const result = await run(
    { pattern: 'reflection', patternConfig: { reflections: 1, judgeProviderId: judge.id } },
    'What model are you?',
  );
  const responses = result.events.filter((e: any) => e.type === 'model_response');
  assert.ok(responses.some((e: any) => e.data.requestedModel === 'test-identity-judge'));
  assert.ok(responses.some((e: any) => e.data.requestedModel === 'test-identity'));
  const output = JSON.parse(result.output);
  assert.deepEqual(output.identities, [output.requested]);
});

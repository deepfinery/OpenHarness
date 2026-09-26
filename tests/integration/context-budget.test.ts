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
    name: 'Context regression provider',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model,
    ...providerSettings,
  });
  const agent = await ok('/agents', {
    name: 'Context regression agent',
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

test('32k rejection learns dense tokenizer usage and archives a large current request', async () => {
  const { agent: a, provider } = await agent('test-context-32k');
  const input =
    'Research NVDA SNDK MU VIST AVGO NBIS CRWV GOOG AMZN TSLA SPCX ORCL META ADBE. ' +
    'https://source.example/markets?id=1738&risk=uncertain '.repeat(550) +
    ' END: cite sources and risks.';
  const result = await run(a.id, input, [{ role: 'user', content: 'Earlier research. '.repeat(1700) }]);
  assert.equal(result.status, 'succeeded', result.error);
  assert.ok(result.events.some((e: any) => e.type === 'context_retry'));
  assert.ok(result.events.some((e: any) => e.type === 'context_compacted'));
  assert.equal((await ok(`/providers/${provider.id}`)).contextWindow, 32768);
  const notes = (await ok(`/runs/${result.id}/memory`)).notes;
  assert.ok(notes.some((n: any) => n.kind === 'context'));
  assert.match(result.output, /NVDA/);
  assert.match(result.output, /sources and risks/);
  const second = await run(a.id, input);
  assert.equal(second.status, 'succeeded', second.error);
  assert.ok(
    !second.events.some((e: any) => e.type === 'context_retry'),
    'learned tokenizer density protects later runs',
  );
});

test('single-turn research compresses tool arguments into retrievable task memory before final synthesis', async () => {
  const { agent: a } = await agent('test-context-small', {}, { contextWindow: 8192 });
  const result = await run(a.id, 'context research checkpoint');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Research synthesis/);
  assert.ok(result.events.some((e: any) => e.type === 'context_compacted'));
  const notes = (await ok(`/runs/${result.id}/memory`)).notes;
  const checkpoint = notes.find((n: any) => n.kind === 'context');
  assert.ok(checkpoint, 'displaced calls and observations are retained');
  const saved = await ok(`/runs/${result.id}/memory/${checkpoint.note_id}`);
  assert.match(saved.content, /evidence.example/);
  assert.ok(notes.some((n: any) => n.kind === 'finding'));
});

test('persistent context rejection has bounded retries and an honest result, not a failed run', async () => {
  const { agent: a } = await agent('test-context-reject');
  const result = await run(a.id, 'Research the available evidence');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /assessment is incomplete/);
  assert.doesNotMatch(result.output, /HTTP 400/);
  assert.ok(result.events.filter((e: any) => e.type === 'context_retry').length <= 6);
  assert.ok(result.events.some((e: any) => e.type === 'summary_unavailable'));
  assert.ok(!result.events.some((e: any) => e.type === 'tool_started'));
});

test('context guards still apply when optional proactive memory compaction is disabled', async () => {
  const { agent: a } = await agent(
    'test-context-small',
    { contextCompaction: false },
    { contextWindow: 8192, maxOutputTokens: 32768 },
  );
  const result = await run(a.id, 'Request start. ' + 'long input '.repeat(2200) + ' Request end.');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Request start/);
  assert.match(result.output, /Request end/);
  const stats = await (await fetch(fixture + '/stats')).json();
  const calls = stats.contextRequests.filter((r: any) => r.model === 'test-context-small');
  assert.ok(calls.at(-1).requested < 8192, 'per-call output is clamped to the actual context');
});

test('tiny budgets synthesize before analysis and stop later pattern passes', async () => {
  for (const pattern of ['react', 'plan-execute', 'reflection', 'loop']) {
    const { agent: a } = await agent(
      'test-context-small',
      { pattern, tokenBudget: 1000 },
      { contextWindow: 8192, maxOutputTokens: 1024 },
    );
    const result = await run(a.id, 'context research checkpoint');
    assert.equal(result.status, 'succeeded', result.error);
    assert.match(result.output, /Research synthesis/);
    assert.ok(result.events.some((e: any) => e.type === 'budget_exhausted'));
    assert.equal(result.events.filter((e: any) => e.type === 'model').length, 1);
    assert.ok(!result.events.some((e: any) => e.type === 'tool_started'));
  }
});

test('authentication failures are not mistaken for context exhaustion', async () => {
  const { agent: a } = await agent('test-context-auth');
  const result = await run(a.id, 'Research');
  assert.equal(result.status, 'failed');
  assert.match(result.error, /401/);
  assert.ok(!result.events.some((e: any) => e.type === 'context_retry'));
});

test('oversized tool schemas switch to synthesis before sending an impossible request', async () => {
  const { agent: a } = await agent(
    'test-context-small',
    { delegation: { enabled: true } },
    { contextWindow: 2048 },
  );
  const result = await run(a.id, 'context research checkpoint');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Research synthesis/);
  assert.ok(result.events.some((e: any) => e.type === 'context_limit'));
  assert.ok(!result.events.some((e: any) => e.type === 'tool_started'));
});

test('instructions larger than the context remain intact and produce an explicit incomplete result', async () => {
  const { agent: a } = await agent(
    'test-context-small',
    { systemPrompt: 'Mandatory operating constraint. '.repeat(800) },
    { contextWindow: 2048 },
  );
  const result = await run(a.id, 'Research the evidence');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /assessment is incomplete/);
  assert.ok(result.events.some((e: any) => e.type === 'summary_unavailable'));
  assert.equal(result.events.filter((e: any) => e.type === 'model').length, 0);
});

test('a request that must be shortened cannot authorize tool actions from partial instructions', async () => {
  const { agent: a } = await agent('test-context-small', {}, { contextWindow: 8192 });
  const result = await run(
    a.id,
    'context research checkpoint ' + 'long background '.repeat(1800) + ' Do not change any files.',
  );
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Research synthesis/);
  assert.ok(result.events.some((e: any) => e.type === 'context_limit'));
  assert.ok(!result.events.some((e: any) => e.type === 'tool_started'));
  assert.ok((await ok(`/runs/${result.id}/memory`)).notes.some((n: any) => n.kind === 'context'));
});

test('early compression does not shorten a current request that fits the hard allowance', async () => {
  const { agent: a } = await agent('test-chat', { maxTurns: 1 }, { contextWindow: 8192 });
  const result = await run(a.id, 'context research checkpoint ' + 'background '.repeat(700));
  assert.equal(result.status, 'succeeded', result.error);
  assert.ok(
    (await ok(`/runs/${result.id}/memory`)).notes.some((n: any) => n.kind === 'finding'),
    'analysis can still run with the complete request',
  );
});

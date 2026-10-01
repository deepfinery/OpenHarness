import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';

test('loaded skill, complete authored notes and workspace state survive compaction and forced reporting', async () => {
  const skill = await ok('/skills', {
    name: 'Complete report contract',
    description: 'Use for skill report regression.',
    instructions:
      'Mandatory phase C: cover the exact list.\n' +
      'Preserve the scope.\n'.repeat(500) +
      'FINAL-SKILL-CONTRACT: RUN INCOMPLETE with no ratings if coverage is below 90%.',
  });
  const { provider } = await agent(
    'test-skill-report',
    {},
    { contextWindow: 24000, maxOutputTokens: 2000, streaming: false },
  );
  const connection = await ok('/connections', {
    name: 'Skill evidence MCP',
    url: 'http://fixtures:9090/mcp',
  });
  await ok(`/connections/${connection.id}/discover`, {});
  const workflow = await ok('/workflows', {
    name: 'Skill reporting regression',
    startAt: 'agent',
    nodes: [
      {
        id: 'agent',
        name: 'Research',
        type: 'agent',
        prompt: '{{input}}',
        next: 'finish',
        config: {
          name: 'Skill reporter',
          providerId: provider.id,
          systemPrompt: 'Follow the applicable skill and record evidence.',
          skillIds: [skill.id],
          connections: [{ connectionId: connection.id, tools: ['lookup'] }],
          maxTurns: 5,
          tokenBudget: 300000,
        },
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
  });
  const started = await ok('/runs', {
    workflowId: workflow.id,
    input: `skill report regression ${randomUUID()}`,
  });
  let result: any;
  for (let i = 0; i < 120; i++) {
    result = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /^RUN INCOMPLETE/);
  assert.match(result.output, /SKILL-RETAINED FINDING-RETAINED STATE-RETAINED/);
  assert.match(result.output, /INDEX-RETAINED/);
  assert.ok(result.events.some((e: any) => e.type === 'context_compacted'));
  assert.ok(result.events.some((e: any) => e.type === 'skill_incomplete'));
  const read = result.events.find(
    (e: any) => e.type === 'tool_completed' && e.data?.tool === 'workspace_read',
  );
  assert.ok(read, 'state was read through the paged workspace tool');
  const resultPage = JSON.parse(read.data.result);
  assert.equal(resultPage.offset, 12000);
  assert.equal(resultPage.next_offset, 16000);
  assert.equal(resultPage.content.length, 4000);
  assert.ok(resultPage.total_chars > 19000);
});
let cookie = '';
async function ok(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + '/api' + path, {
    method,
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

test('output-limit retries grow the reply allowance, account streamed usage, and never execute truncated tools', async () => {
  const { agent: a } = await agent('test-output-grow', {}, { maxOutputTokens: 1024 });
  const result = await run(a.id, 'Analyze AAA, BBB and CCC');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /all requested items/);
  const retries = result.events.filter((e: any) => e.type === 'model_retry');
  assert.deepEqual(
    retries.map((e: any) => e.data.maxOutputTokens),
    [1024, 2048],
  );
  const notes = (await ok(`/runs/${result.id}/memory`)).notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Verified evidence');
  const stats = await (await fetch(fixture + '/stats')).json();
  const calls = stats.outputRequests.filter((r: any) => r.model === 'test-output-grow');
  assert.equal(calls[0].includeUsage, true);
  assert.equal(
    result.tokensUsed,
    calls.reduce((n: number, r: any) => n + r.usage.prompt_tokens + r.usage.completion_tokens, 0),
  );
});

test('persistent output limits finish through saved-evidence synthesis with follow-up scope intact', async () => {
  const { agent: a } = await agent('test-output-persistent', {}, { maxOutputTokens: 1024 });
  const result = await run(a.id, 'Please provide the rest', [
    { role: 'user', content: 'Analyze AAA, BBB and CCC' },
    { role: 'assistant', content: 'AAA is covered; BBB and CCC remain.' },
  ]);
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Recovered analysis/);
  assert.ok(result.events.some((e: any) => e.type === 'recovery_limit'));
  assert.ok(
    result.events.some(
      (e: any) => e.type === 'model_request' && e.data.finalAnswer && e.data.toolCount === 0,
    ),
  );
  assert.equal(result.events.filter((e: any) => e.type === 'tool_started').length, 1);
  assert.ok(result.tokensUsed <= 200000);
});

test('truncated final prose continues without losing earlier sections', async () => {
  const { agent: a } = await agent('test-output-continue', {}, { maxOutputTokens: 1024 });
  const result = await run(a.id, 'Analyze AAA, BBB and CCC');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Verified section 1/);
  assert.match(result.output, /Verified section 2/);
  assert.equal(result.output.match(/Verified section 1/g)?.length, 1);
  assert.ok(!result.summaryUnavailable);
});

test('bounded final continuation preserves available text and discloses incompleteness instead of a raw model error', async () => {
  for (const [model, budget] of [
    ['test-output-partial', 200000],
    ['test-output-small', 6000],
  ] as const) {
    const { agent: a } = await agent(model, { tokenBudget: budget }, { maxOutputTokens: 1024 });
    const result = await run(a.id, 'Analyze AAA, BBB and CCC');
    assert.equal(result.status, 'succeeded', result.error);
    assert.match(result.output, /Verified section 1/);
    assert.match(result.output, /unfinished sections remain incomplete/);
    assert.ok(result.tokensUsed <= budget, `${result.tokensUsed} exceeded ${budget}`);
    assert.ok(result.events.filter((e: any) => e.type === 'model_request' && e.data.finalAnswer).length <= 3);
    assert.ok(!result.summaryUnavailable);
  }
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
  // Leave room for protected runtime policies while forcing large tool exchanges to compact.
  const { agent: a } = await agent('test-context-small', {}, { contextWindow: 8192, maxOutputTokens: 2048 });
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

test('persistent context rejection has bounded retries and reports incomplete execution', async () => {
  const { agent: a } = await agent('test-context-reject');
  const result = await run(a.id, 'Research the available evidence');
  assert.equal(result.status, 'failed');
  assert.equal(result.summaryUnavailable, true);
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
  assert.equal(result.status, 'failed');
  assert.equal(result.summaryUnavailable, true);
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
  const result = await run(a.id, 'context research checkpoint ' + 'background '.repeat(550));
  assert.equal(result.status, 'succeeded', result.error);
  assert.ok(
    (await ok(`/runs/${result.id}/memory`)).notes.some((n: any) => n.kind === 'finding'),
    'analysis can still run with the complete request',
  );
});

test('a 1M provider retains harness history beyond the old 128k default', async () => {
  const { provider } = await agent('test-context-million', {}, { contextWindow: 1000000 });
  const workflow = await ok('/workflows', {
    name: 'Million context harness',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'agent' },
      {
        id: 'agent',
        type: 'agent',
        name: 'Research',
        prompt: '{{input}}',
        next: 'finish',
        config: {
          name: 'Large context agent',
          providerId: provider.id,
          systemPrompt: 'Read the supplied history.',
          tokenBudget: 2000000,
        },
      },
      { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
    ],
  });
  const started = await ok('/runs', {
    workflowId: workflow.id,
    input: 'Summarize the retained history.',
    history: Array.from({ length: 18 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: 'Historical evidence. '.repeat(1500),
    })),
  });
  let result: any;
  for (let i = 0; i < 120; i++) {
    result = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(result.status, 'succeeded', result.error);
  assert.ok(
    !result.events.some((e: any) => ['context_compacted', 'context_limit', 'context_retry'].includes(e.type)),
  );
  const stats = await (await fetch(fixture + '/stats')).json();
  const calls = stats.contextRequests.filter((r: any) => r.model === 'test-context-million');
  assert.ok(calls.some((r: any) => r.counted > 128000 && r.counted + r.requested < 1000000));
  assert.equal((await ok(`/providers/${provider.id}`)).contextWindow, 1000000);
});

test('an in-flight limit error cannot undo an operator increase to 1M', async () => {
  const { agent: a, provider } = await agent('test-context-upgrade');
  const marker = `upgrade-probe-${randomUUID()}`;
  const pending = run(a.id, marker);
  try {
    let observed = false;
    for (let i = 0; i < 100; i++) {
      const stats = await (await fetch(fixture + '/stats')).json();
      if (stats.contextUpgradeStarted?.includes(marker)) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(observed, 'the original provider request is in flight');
    await ok(`/providers/${provider.id}`, { ...provider, contextWindow: 1000000 }, 'PUT');
  } finally {
    await fetch(fixture + '/context-upgrade/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marker }),
    });
  }
  const result = await pending;
  assert.equal(result.status, 'succeeded', result.error);
  assert.ok(result.events.some((e: any) => e.type === 'context_retry'));
  assert.equal((await ok(`/providers/${provider.id}`)).contextWindow, 1000000);
});

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

test('autonomous loop stops at a skill gate instead of rewriting the blocked report', async () => {
  const skill = await ok('/skills', {
    name: 'Coverage gate',
    description: 'Required for the coverage request.',
    instructions:
      'If fewer than 90% of required prices are available, stop with RUN INCOMPLETE and no ratings.',
  });
  for (const skillIds of [[skill.id], []]) {
    const { agent: a } = await agent('test-loop-blocked', {
      pattern: 'loop',
      patternConfig: { iterations: 6 },
      skillIds,
    });
    const result = await run(a.id, 'Check required price coverage');
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(
      result.output,
      skillIds.length
        ? '# RUN INCOMPLETE — Coverage check\n\n121/138 fresh prices. 14 access denied; 3 unavailable. Mandatory 90% gate failed. No ratings.'
        : 'Required access is unavailable. Restore access to continue.',
    );
    const iterations = result.events.filter((e: any) => e.type === 'iteration');
    assert.equal(iterations.length, 1);
    assert.equal(iterations[0].data.outcome, 'blocked');
    assert.equal(
      result.events.some((e: any) => e.type === 'loop_limit'),
      false,
    );
    const history = await ok(`/runs/${result.id}/activity`);
    assert.deepEqual(
      history.entries.map((e: any) => e.label),
      ['Iteration 1'],
    );
    const saved = await ok(`/runs/${result.id}/activity/${history.entries[0].id}`);
    assert.ok(saved.content.startsWith(result.output));
  }
});

test('autonomous loop continues actionable progress and removes its final control footer', async () => {
  const { agent: a } = await agent('test-chat', { pattern: 'loop' });
  const started = await ok('/runs', { agentId: a.id, input: 'Complete the two halves' });
  let result: any;
  for (let i = 0; i < 120; i++) {
    result = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(result.status)) break;
    assert.ok(!result.partial, 'iteration drafts and control footers must not stream into the answer');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.output, 'Finished the task.');
  assert.deepEqual(
    result.events.filter((e: any) => e.type === 'iteration').map((e: any) => e.data.outcome),
    ['continue', 'done'],
  );
  const history = await ok(`/runs/${started.id}/activity`);
  assert.deepEqual(
    history.entries.map((e: any) => e.label),
    ['Iteration 1', 'Iteration 2'],
  );
});

test('reflection keeps intermediate text out of chat and exposes complete tenant-scoped stage history', async () => {
  const { agent: a } = await agent('test-reflection-history', { pattern: 'reflection' });
  const started = await ok('/runs', { agentId: a.id, input: 'Prepare a reviewed answer' });
  let finished: any;
  for (let i = 0; i < 160; i++) {
    const current = await ok(`/runs/${started.id}`);
    if (!['queued', 'running'].includes(current.status)) {
      finished = current;
      break;
    }
    assert.ok(!current.partial, 'drafts and critiques must not stream into the answer');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(finished?.status, 'succeeded', finished?.error);
  assert.equal(finished.output, 'Final revised answer with verified evidence.');
  const history = await ok(`/runs/${started.id}/activity`);
  assert.deepEqual(
    history.entries.map((e: any) => e.label),
    ['Draft', 'Critique 1', 'Revision 1'],
  );
  assert.ok(history.entries.every((e: any) => e.status === 'completed' && e.content === undefined));
  const saved = await Promise.all(
    history.entries.map((e: any) => ok(`/runs/${started.id}/activity/${e.id}`)),
  );
  assert.ok(saved[0].content.length > 6000);
  assert.match(saved[0].content, /DRAFT END$/);
  assert.ok(saved[1].content.length > 6000);
  assert.match(saved[1].content, /REVIEW END$/);
  assert.equal(saved[2].content, finished.output);
  assert.deepEqual((await ok(`/runs/${started.id}/activity`)).entries, history.entries);
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@openharness.test', password: 'Integration-test-password-42' }),
  });
  const otherCookie = login.headers.get('set-cookie')!.split(';')[0];
  for (const path of [`/runs/${started.id}/activity`, `/runs/${started.id}/activity/${saved[0].id}`]) {
    const denied = await fetch(base + '/api' + path, { headers: { Cookie: otherCookie } });
    assert.equal(denied.status, 404);
  }
});

test('reflection history preserves output redaction', async () => {
  const policy = await ok('/guardrails', {
    name: 'Private reflection output',
    provider: 'builtin',
    stages: ['output'],
    pii: true,
  });
  const { agent: a } = await agent('test-guardrail', { pattern: 'reflection', guardrailIds: [policy.id] });
  const result = await run(a.id, 'guarded private output');
  assert.equal(result.status, 'succeeded', result.error);
  const history = await ok(`/runs/${result.id}/activity`);
  const saved = await Promise.all(history.entries.map((e: any) => ok(`/runs/${result.id}/activity/${e.id}`)));
  assert.match(saved[0].content, /\[EMAIL\]/);
  assert.ok(saved.every((e: any) => !e.content.includes('alice@example.com')));
});

// Deterministic HTTP prompt contracts, not a claim to evaluate a live model's translation ability.
test('language policy and original request reach every pattern, child and final synthesis', async () => {
  const cases = [
    {
      pattern: 'react',
      input: 'Analyze Nvidia stock and latest news, is it bulish or bearish? what is the outlook?',
    },
    { pattern: 'reflection', input: 'Erkläre die Ergebnisse.' },
    { pattern: 'plan-execute', input: 'Explain the results in Japanese.' },
    { pattern: 'loop', input: 'Summarize the results in English.' },
    { pattern: 'react', input: 'delegate-language: Analyze the outlook in English.', delegate: true },
    { pattern: 'react', input: 'research-language: Explain the evidence.', synthesis: true },
  ];
  for (const scenario of cases) {
    const input = `${scenario.input} [${randomUUID()}]`;
    const { agent: a } = await agent('test-language', {
      pattern: scenario.pattern,
      timezone: 'Europe/Berlin',
      maxTurns: scenario.synthesis ? 1 : 6,
      patternConfig: { iterations: 1 },
      delegation: { enabled: Boolean(scenario.delegate) },
    });
    const result = await run(a.id, input, [
      { role: 'user', content: 'Antworte auf Deutsch.' },
      { role: 'assistant', content: 'Hier ist die vorherige Antwort.' },
    ]);
    assert.equal(result.status, 'succeeded', result.error);
    const stats = await (await fetch(fixture + '/stats')).json();
    const calls = stats.languageRequests.filter((r: any) => r.source?.endsWith(input));
    assert.ok(calls.length >= (scenario.pattern === 'reflection' ? 3 : 1));
    for (const call of calls) {
      assert.match(call.system, /Reply in the language of the original user request/);
      assert.match(call.system, /unless it explicitly requests another output language/);
      assert.match(call.system, /timezone and internal task prompts must not change/);
      assert.ok(!call.system.includes(input), 'user wording must not become system instructions');
    }
    if (scenario.delegate) assert.ok(calls.some((r: any) => r.latest === 'Prüfe die deutschen Quellen.'));
    if (scenario.synthesis) assert.ok(calls.some((r: any) => r.system.includes('Analysis has ended.')));
  }
});

test('workflow wrappers retain the original request language without bypassing input redaction', async () => {
  const policy = await ok('/guardrails', {
    name: 'Private language reference',
    provider: 'builtin',
    stages: ['input'],
    pii: true,
  });
  const { agent: a, provider } = await agent('test-language', { guardrailIds: [policy.id] });
  const workflow = await ok('/workflows', {
    name: 'Language wrapper regression',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'agent' },
      {
        id: 'agent',
        type: 'agent',
        name: 'Research',
        prompt: 'Prüfe die deutschen Quellen.',
        next: 'finish',
        config: {
          name: 'Language worker',
          providerId: provider.id,
          systemPrompt: 'Research accurately.',
          tokenBudget: 200000,
          guardrailIds: [policy.id],
        },
      },
      { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
    ],
  });
  for (const target of [{ agentId: a.id }, { workflowId: workflow.id }]) {
    const marker = randomUUID();
    const input = `Explain the outlook in English for alice@example.com. ${marker}`;
    const started = await ok('/runs', { ...target, input });
    let result: any;
    for (let i = 0; i < 120; i++) {
      result = await ok(`/runs/${started.id}`);
      if (!['queued', 'running'].includes(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(result.status, 'succeeded', result.error);
    const stats = await (await fetch(fixture + '/stats')).json();
    const calls = stats.languageRequests.filter((r: any) => r.source?.includes(marker));
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.match(call.source, /Explain the outlook in English/);
      assert.match(call.source, /\[EMAIL\]/);
      assert.doesNotMatch(JSON.stringify(call), /alice@example.com/);
      if ('workflowId' in target) assert.equal(call.latest, 'Prüfe die deutschen Quellen.');
    }
  }
});

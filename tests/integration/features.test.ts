import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { makeStarter } from '../../packages/core/src/starters.js';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
const suffix = randomUUID().slice(0, 8);
let cookie = '';
let provider: any, connection: any;
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined, headers: response.headers };
}
async function ok(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await request(path, method, body);
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
const stats = async () => (await (await fetch(`${fixture}/stats`)).json()) as any;
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
before(async () => {
  // This file sorts before stack.test.ts, so it may be the first to touch a fresh stack.
  const status = await (await fetch(base + '/api/auth/status')).json();
  if (status.needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice('SETUP_TOKEN='.length);
    await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...admin, name: 'Test Administrator', setupToken }),
    });
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(admin),
  });
  assert.equal(login.status, 200, 'Could not sign in to the isolated stack');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  provider = await ok('/providers', {
    name: `Streaming model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  connection = await ok('/connections', { name: `Feature MCP ${suffix}`, url: 'http://fixtures:9090/mcp' });
  await ok(`/connections/${connection.id}/discover`, {});
});
test('provider drafts can be tested before saving, including the embedding model', async () => {
  const result = await ok('/providers/test-config', {
    name: 'Draft',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  assert.equal(result.chat.ok, true);
  assert.match(result.chat.text, /Completed/);
  assert.equal(result.embedding.ok, true);
  assert.equal(result.embedding.dimensions, 4);
  const broken = await ok('/providers/test-config', {
    name: 'Draft',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/missing',
    model: 'test-chat',
  });
  assert.equal(broken.chat.ok, false);
  assert.match(broken.chat.error, /HTTP 404/);
});
test('answers stream token by token and the run stream delivers events until completion', async () => {
  const before = (await stats()).streams ?? 0;
  const agent = await ok('/agents', {
    name: `Streamer ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Answer briefly.',
    connections: [{ connectionId: connection.id, tools: ['lookup'] }],
  });
  const run = await ok('/runs', { agentId: agent.id, input: 'Please use tool for streaming' });
  const response = await fetch(`${base}/api/runs/${run.id}/stream`, {
    headers: { Cookie: cookie, Origin: base },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen: any[] = [];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const block of buffer.split('\n\n').slice(0, -1)) {
      const data = block.split('\n').find((l) => l.startsWith('data:'));
      if (data) seen.push(JSON.parse(data.slice(5)));
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    if (seen.at(-1)?.status === 'succeeded') break;
  }
  assert.equal(seen.at(-1)?.status, 'succeeded', JSON.stringify(seen.at(-1)?.error));
  assert.ok(seen.length >= 2, 'the stream should deliver intermediate states');
  assert.match(seen.at(-1).output, /MCP lookup: orchestration test/);
  assert.ok(seen.at(-1).events.some((e: any) => e.type === 'tool_completed'));
  assert.ok(((await stats()).streams ?? 0) > before, 'the model request used streaming');
  const final = await ok(`/runs/${run.id}`);
  assert.equal(final.partial, undefined, 'streamed text is cleared once the answer is final');
});
for (const mode of ['arguments', 'incomplete', 'persistent']) {
  test(`model response recovery (${mode}) preserves prior MCP results and never executes partial batches`, async () => {
    const own = await ok('/providers', {
      name: `Response recovery ${mode} ${suffix}`,
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: `test-response-${mode}`,
    });
    const agent = await ok('/agents', {
      name: `Recovery ${mode} ${suffix}`,
      providerId: own.id,
      systemPrompt: 'Inspect the machine using tools.',
      effort: 'high',
      connections: [{ connectionId: connection.id, tools: ['lookup'] }],
    });
    const run = await waitRun(
      (await ok('/runs', { agentId: agent.id, input: 'Please use tool for recovery' })).id,
    );
    const retries = run.events.filter((e: any) => e.type === 'model_retry');
    const calls = run.events.filter((e: any) => e.type === 'tool_started');
    assert.equal(retries.length, mode === 'persistent' ? 2 : 1);
    assert.equal(retries[0].data.reason, mode === 'incomplete' ? 'incomplete_stream' : 'tool_arguments');
    assert.equal(
      calls.filter((e: any) => e.data.arguments.includes('orchestration test')).length,
      1,
      'prior tool call is not replayed',
    );
    assert.ok(!JSON.stringify(retries).includes('x'.repeat(30)), 'raw malformed arguments are not logged');
    if (mode === 'persistent') {
      assert.equal(run.status, 'failed');
      assert.equal(calls.length, 1, 'even the valid call preceding an invalid call must not execute');
      assert.match(run.error, /malformed or incomplete JSON arguments/);
      assert.equal(run.events.filter((e: any) => e.type === 'model_error').length, 1);
    } else {
      assert.equal(run.status, 'succeeded', run.error);
      assert.equal(calls.length, 2);
      assert.match(run.output, /recovered call/);
    }
    assert.equal(run.partial, undefined);
  });
}

test('agentic patterns run their passes and record them in the trace', async () => {
  const planner = await ok('/agents', {
    name: `Planner ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Plan then act.',
    pattern: 'plan-execute',
    patternConfig: { maxPlanSteps: 3 },
    connections: [{ connectionId: connection.id, tools: ['lookup'] }],
  });
  const planned = await waitRun((await ok('/runs', { agentId: planner.id, input: 'Prepare a briefing' })).id);
  assert.equal(planned.status, 'succeeded', planned.error);
  assert.match(planned.output, /Planned answer: Prepare a briefing/);
  assert.deepEqual(planned.events.find((e: any) => e.type === 'plan').data.steps.length, 2);
  assert.equal(planned.events.filter((e: any) => e.type === 'plan_step').length, 2);

  const writer = await ok('/agents', {
    name: `Writer ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Write well.',
    pattern: 'reflection',
    patternConfig: { reflections: 1 },
  });
  const reflected = await waitRun((await ok('/runs', { agentId: writer.id, input: 'Draft a note' })).id);
  assert.equal(reflected.status, 'succeeded', reflected.error);
  assert.equal(reflected.output, 'Revised answer with a source.');
  assert.equal(reflected.events.filter((e: any) => e.type === 'reflection').length, 1);

  const worker = await ok('/agents', {
    name: `Worker ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Work in loops.',
    pattern: 'loop',
    patternConfig: { iterations: 4, doneMarker: 'DONE' },
  });
  const looped = await waitRun((await ok('/runs', { agentId: worker.id, input: 'Finish the checklist' })).id);
  assert.equal(looped.status, 'succeeded', looped.error);
  assert.equal(looped.output, 'Finished the task.');
  assert.equal(looped.events.filter((e: any) => e.type === 'iteration').length, 2);
  assert.equal(
    (await request('/agents', 'POST', { ...planner, id: undefined, pattern: 'invented' })).status,
    400,
  );
});
test('multi-agent starters run end to end, passing results between agents', async () => {
  const team = await ok(
    '/workflows',
    makeStarter({ kind: 'team', providerId: provider.id, connectionId: connection.id, tools: ['lookup'] }),
  );
  const run = await waitRun((await ok('/runs', { workflowId: team.id, input: 'Compare two vendors' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.deepEqual(
    run.events.filter((e: any) => e.type === 'node_started').map((e: any) => e.nodeId),
    ['start', 'planner', 'researcher', 'writer', 'finish'],
  );
  assert.ok(run.events.some((e: any) => e.type === 'plan' && e.nodeId === 'researcher'));
  assert.ok(run.events.some((e: any) => e.type === 'reflection' && e.nodeId === 'writer'));
  const router = await ok('/workflows', makeStarter({ kind: 'router', providerId: provider.id }));
  const routed = await waitRun((await ok('/runs', { workflowId: router.id, input: 'pricing question' })).id);
  assert.equal(routed.status, 'succeeded', routed.error);
  assert.ok(routed.events.some((e: any) => e.type === 'node_started' && e.nodeId === 'route'));
});
test('email settings are workspace-scoped and the Email step sends through them', async () => {
  const initial = await ok('/settings/email');
  assert.equal(initial.hasPassword, false);
  const saved = await ok(
    '/settings/email',
    {
      host: 'fixtures',
      port: 587,
      secure: false,
      username: 'reports',
      password: 'secret-value',
      from: 'reports@example.com',
      enabled: true,
    },
    'PUT',
  );
  assert.equal(saved.source, 'workspace');
  assert.equal(saved.hasPassword, true);
  assert.equal(JSON.stringify(saved).includes('secret-value'), false);
  const kept = await ok('/settings/email', { ...saved, password: undefined }, 'PUT');
  assert.equal(kept.hasPassword, true, 'omitting the password keeps the saved one');
  const test = await ok('/settings/email/test', { to: 'someone@example.com' });
  assert.deepEqual(test.recipients, ['someone@example.com']);
  const flow = await ok(
    '/workflows',
    makeStarter({ kind: 'notify', providerId: provider.id, connectionId: connection.id, tools: ['lookup'] }),
  );
  const emailNode = flow.nodes.find((n: any) => n.type === 'email');
  emailNode.to = 'team@example.com, lead@example.com';
  await ok(`/workflows/${flow.id}`, flow, 'PUT');
  const run = await waitRun((await ok('/runs', { workflowId: flow.id, input: 'Weekly numbers' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.ok(run.events.some((e: any) => e.type === 'email_sent' && e.nodeId === 'email'));
  assert.deepEqual(run.outputs.email.recipients, ['team@example.com', 'lead@example.com']);
  assert.equal(run.outputs.email.subject, 'Report: Weekly numbers');
  emailNode.to = 'not-an-address';
  await ok(`/workflows/${flow.id}`, flow, 'PUT');
  const bad = await waitRun((await ok('/runs', { workflowId: flow.id, input: 'Weekly numbers' })).id);
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /Invalid email recipient/);
  assert.equal(
    (await request('/settings/email', 'PUT', { host: '169.254.169.254', from: 'a@b.co' })).status,
    400,
  );
  await ok('/settings/email', undefined, 'DELETE');
  assert.notEqual((await ok('/settings/email')).source, 'workspace');
});
test('a context-length rejection is recovered by compacting the dialog and remembered on the provider', async () => {
  const own = await ok('/providers', {
    name: `Small window ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  assert.equal(own.contextWindow, 128000);
  const agent = await ok('/agents', {
    name: `Long memory ${suffix}`,
    providerId: own.id,
    systemPrompt: 'Chat.',
  });
  const filler = 'Earlier discussion about vendors and pricing. '.repeat(120);
  const history = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    content: `${filler} (${i})`,
  }));
  const before = (await stats()).contextRejections ?? 0;
  const run = await waitRun(
    (await ok('/runs', { agentId: agent.id, input: 'Now answer the final question', history })).id,
  );
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /final question/);
  assert.ok(
    run.events.some((e: any) => e.type === 'context_compacted'),
    'the trace records the compaction',
  );
  assert.ok(((await stats()).contextRejections ?? 0) > before, 'the provider rejected the first attempt');
  assert.equal((await ok(`/providers/${own.id}`)).contextWindow, 6000, 'the learned window is stored');
  const second = await waitRun((await ok('/runs', { agentId: agent.id, input: 'Again', history })).id);
  assert.equal(second.status, 'succeeded', second.error);
  assert.equal((await stats()).contextRejections, before + 1, 'later runs pre-trim instead of failing first');
});
test('a model whose tokenizer counts more than the estimate still gets a prompt that fits', async () => {
  // The reported case: a 32k model rejected the prompt three times because the estimate said it already fit.
  const dense = await ok('/providers', {
    name: `Dense tokenizer ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-dense',
    maxOutputTokens: 1024,
  });
  const agent = await ok('/agents', {
    name: `Dense reader ${suffix}`,
    providerId: dense.id,
    systemPrompt: 'Chat.',
  });
  const filler = 'https://news.example.com/markets/sp500?id=4821&ref=search {"title":"S&P 500"} '.repeat(70);
  const history = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    content: `${filler} (${i})`,
  }));
  const before = (await stats()).denseRejections ?? 0;
  const run = await waitRun(
    (await ok('/runs', { agentId: agent.id, input: 'Any market news today?', history })).id,
  );
  assert.equal(run.status, 'succeeded', run.error);
  assert.ok(((await stats()).denseRejections ?? 0) > before, 'the provider rejected the untrimmed prompt');
  assert.ok(run.events.some((e: any) => e.type === 'context_compacted'));
  assert.equal((await ok(`/providers/${dense.id}`)).contextWindow, 12000);
});
test('effort budgets cap the tokens an agent may spend and auto effort resolves a level per request', async () => {
  const providers = await ok('/providers');
  const provider = providers.find((p: any) => p.baseUrl === 'http://fixtures:9090/v1') ?? providers[0];
  const connection = (await ok('/connections')).find((c: any) =>
    c.tools?.some((t: any) => t.name === 'lookup'),
  );
  assert.ok(connection, 'a fixture MCP connection with the lookup tool exists');
  const frugal = await ok('/agents', {
    name: `Frugal ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Help.',
    effort: 'light',
    tokenBudget: 1000,
    connections: [{ connectionId: connection.id, tools: ['lookup'] }],
  });
  assert.equal(frugal.effort, 'light');
  const filler = 'Background about the vendor contract. '.repeat(120);
  const run = await waitRun(
    (await ok('/runs', { agentId: frugal.id, input: `${filler} Now use tool please` })).id,
  );
  assert.equal(run.status, 'succeeded', run.error);
  const exhausted = run.events.find((e: any) => e.type === 'budget_exhausted');
  assert.ok(exhausted, 'the trace records the exhausted token budget');
  assert.equal(exhausted.data.tokenBudget, 1000);
  assert.ok(
    run.events.some((e: any) => e.type === 'tool_completed'),
    'the first tool call still ran',
  );
  assert.ok(run.output.length > 0, 'the agent answered with what it had');
  const auto = await ok('/agents', {
    name: `Auto ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Help.',
    effort: 'auto',
    connections: [{ connectionId: connection.id, tools: ['lookup'] }],
  });
  const autoRun = await waitRun(
    (await ok('/runs', { agentId: auto.id, input: 'use tool for a quick fact' })).id,
  );
  assert.equal(autoRun.status, 'succeeded', autoRun.error);
  const effort = autoRun.events.find((e: any) => e.type === 'effort');
  assert.equal(effort?.data.level, 'medium', 'tools attached with a short request resolves to medium');
  assert.equal(effort?.data.maxTurns, 12);
  assert.equal((await request('/agents', 'POST', { ...frugal, effort: 'gigantic' })).status, 400);
});
test('knowledge notes are created, edited and re-indexed in place', async () => {
  const kb = await ok('/knowledge', { name: `Notebook ${suffix}`, providerId: provider.id });
  const note = await ok(`/knowledge/${kb.id}/notes`, {
    title: 'Vendor policy',
    content: '# Vendor policy\n\nAll vendors are approved by finance.',
  });
  assert.equal(note.filename, 'Vendor policy.md');
  assert.equal(note.kind, 'note');
  const ready = async () => {
    for (let i = 0; i < 80; i++) {
      const docs = await ok(`/knowledge/${kb.id}/documents`);
      const d = docs.find((x: any) => x.id === note.id);
      if (d?.status === 'ready') return d;
      if (d?.status === 'failed') throw new Error(d.error);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('note was not indexed');
  };
  const indexed = await ready();
  assert.ok(indexed.chunks >= 1);
  const content = await ok(`/documents/${note.id}/content`);
  assert.match(content.content, /approved by finance/);
  assert.equal(content.kind, 'note');
  // Editing overwrites the stored file, keeps the id and queues a fresh index.
  const edited = await ok(
    `/documents/${note.id}`,
    { title: 'Vendor policy v2', content: '# Vendor policy\n\nRenewals need a fresh review.' },
    'PUT',
  );
  assert.equal(edited.status, 'queued');
  const again = await ready();
  assert.equal(again.filename, 'Vendor policy v2.md');
  assert.match((await ok(`/documents/${note.id}/content`)).content, /fresh review/);
  const hits = await ok(`/knowledge/${kb.id}/search`, { query: 'renewals review' });
  assert.ok(
    hits.some((h: any) => /fresh review/.test(h.content)),
    'search sees the edited text',
  );
  assert.ok(!hits.some((h: any) => /approved by finance/.test(h.content)), 'old passages are replaced');
  assert.equal((await request(`/documents/${note.id}/content`, 'GET')).status, 200);
  const pdfLike = await request(`/documents/${randomUUID()}/content`, 'GET');
  assert.equal(pdfLike.status, 404);
});
test('agents load the matching skill on demand and follow it; skills are snapshotted per run', async () => {
  const triage = await ok('/skills', {
    name: `Incident triage ${suffix}`,
    description: 'Use when someone reports an outage or error spike.',
    instructions: 'TRIAGE-STEPS: classify severity, then list evidence.',
  });
  const release = await ok('/skills', {
    name: `Release notes ${suffix}`,
    description: 'Use when asked to write release notes.',
    instructions: 'RELEASE-FORMAT: headline, changes, upgrade notes.',
  });
  const agent = await ok('/agents', {
    name: `Skilled ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Help the team.',
    skillIds: [triage.id, release.id],
    // A client cannot smuggle instructions in as a snapshot; the server resolves skills itself.
    skills: [{ id: triage.id, name: 'x', description: 'x', instructions: 'SPOOFED', enabled: true }],
  });
  assert.equal(agent.skills, undefined, 'stored agents carry skill ids only');
  const run = await waitRun(
    (await ok('/runs', { agentId: agent.id, input: `Please use your skill: release notes ${suffix} for v2` }))
      .id,
  );
  assert.equal(run.status, 'succeeded', run.error);
  const loaded = run.events.filter((e: any) => e.type === 'skill_loaded');
  assert.equal(loaded.length, 1, 'exactly one skill loaded');
  assert.equal(loaded[0].data.skill, `Release notes ${suffix}`, 'the matching skill, not the first one');
  assert.match(run.output, /RELEASE-FORMAT/, 'the loaded instructions reached the model');
  assert.doesNotMatch(run.output, /SPOOFED/);
  const plain = await waitRun((await ok('/runs', { agentId: agent.id, input: 'Just say hello' })).id);
  assert.equal(plain.status, 'succeeded', plain.error);
  assert.ok(!plain.events.some((e: any) => e.type === 'skill_loaded'), 'no skill when none applies');
  // Editing a skill after acceptance does not change runs; disabling hides it from new runs.
  await ok(`/skills/${release.id}`, { ...release, id: undefined, enabled: false }, 'PUT');
  const after = await waitRun(
    (await ok('/runs', { agentId: agent.id, input: `Please use your skill: release notes ${suffix}` })).id,
  );
  assert.ok(
    after.events
      .filter((e: any) => e.type === 'skill_loaded')
      .every((e: any) => e.data.skill !== `Release notes ${suffix}`),
    'a disabled skill is not offered',
  );
  assert.equal(
    (await request(`/skills/${triage.id}`, 'DELETE')).status,
    409,
    'a skill in use cannot be deleted',
  );
  assert.equal(
    (
      await request('/agents', 'POST', {
        name: 'Bad',
        providerId: provider.id,
        systemPrompt: 'x',
        skillIds: [randomUUID()],
      })
    ).status,
    400,
  );
});
test('the workspace default model provider is stored on the tenant and falls back to the oldest provider', async () => {
  const tenant = await ok('/tenant');
  assert.ok(tenant.defaultProviderId, 'a default exists once any provider does');
  const chosen = await ok('/providers', {
    name: `Default candidate ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  assert.equal((await ok('/tenant', { defaultProviderId: chosen.id }, 'PUT')).defaultProviderId, chosen.id);
  assert.equal((await ok('/tenant')).defaultProviderId, chosen.id);
  assert.equal((await request('/tenant', 'PUT', { defaultProviderId: randomUUID() })).status, 400);
  await ok(`/providers/${chosen.id}`, undefined, 'DELETE');
  assert.notEqual((await ok('/tenant')).defaultProviderId, chosen.id, 'a deleted default falls back');
});
test('conversations are listed per target for their owner and can be deleted', async () => {
  const agent = await ok('/agents', {
    name: `Chatty ${suffix}`,
    providerId: provider.id,
    systemPrompt: 'Chat.',
  });
  const first = await ok('/chat', { agentId: agent.id, message: 'First topic here' });
  await waitRun(first.id);
  const list = await ok(`/conversations?agentId=${agent.id}`);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, first.conversationId);
  assert.equal(list[0].title, 'First topic here');
  assert.equal(list[0].messageCount, 2);
  assert.equal((await ok('/conversations?workflowId=' + randomUUID())).length, 0);
  await ok(`/conversations/${first.conversationId}`, undefined, 'DELETE');
  assert.equal((await ok(`/conversations?agentId=${agent.id}`)).length, 0);
  assert.equal((await request(`/conversations/${first.conversationId}`)).status, 404);
});

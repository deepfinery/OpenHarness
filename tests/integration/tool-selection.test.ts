import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let connectionId = '';

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
    name: 'Tool selection regression provider',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model,
    ...providerSettings,
  });
  const agent = await ok('/agents', {
    name: 'Tool selection regression agent',
    providerId: provider.id,
    systemPrompt: 'Research carefully. Preserve source attribution and uncertainty.',
    connections: [{ connectionId, tools: ['lookup'] }],
    maxTurns: 8,
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
  connectionId = (await ok('/connections', { name: 'Allowed tools', url: 'http://fixtures:9090/mcp' })).id;
  await ok(`/connections/${connectionId}/discover`, {});
});

for (const mode of ['alias', 'unselected', 'disabled', 'batch']) {
  test(`${mode}: rejects the entire batch, retains earlier effects, and recovers with an exact allowed name`, async () => {
    const { agent: a } = await agent(`test-selection-${mode}`);
    const result = await run(a.id, 'Inspect with attached tools');
    assert.equal(result.status, 'succeeded', result.error);
    assert.match(result.output, /Recovered using the allowed tool/);
    const rejected = result.events.filter((e: any) => e.type === 'tool_selection_error');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].data.executed, false);
    assert.ok(!JSON.stringify(rejected).includes('private rejected argument'));
    const calls = result.events.filter((e: any) => e.type === 'tool_started');
    assert.equal(calls.length, 2, 'only the earlier notebook write and corrected MCP call execute');
    assert.equal(calls.filter((e: any) => e.data.tool === 'memory_write').length, 1);
    assert.ok(!JSON.stringify(calls).includes('must not execute'));
    assert.equal(
      (await ok(`/runs/${result.id}/memory`)).notes.filter((n: any) => n.title === 'Prior evidence').length,
      1,
    );
  });
}

test('persistent invalid selection stops after three rejections and summarizes previous evidence', async () => {
  const { agent: a } = await agent('test-selection-persistent', { pattern: 'reflection' });
  const result = await run(a.id, 'Inspect with attached tools');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Assessment incomplete/);
  assert.match(result.output, /Prior evidence retained/);
  assert.equal(result.events.filter((e: any) => e.type === 'tool_selection_error').length, 3);
  assert.equal(result.events.filter((e: any) => e.type === 'tool_started').length, 1);
});

test('planning cannot invoke attached MCP or notebook capabilities that were not offered for that pass', async () => {
  const { agent: a } = await agent('test-selection-plan', { pattern: 'plan-execute' });
  const result = await run(a.id, 'Produce a plan');
  assert.equal(result.status, 'succeeded', result.error);
  assert.match(result.output, /Plan completed/);
  assert.equal(result.events.filter((e: any) => e.type === 'tool_selection_error').length, 1);
  assert.equal(result.events.filter((e: any) => e.type === 'tool_started').length, 0);
  assert.equal((await ok(`/runs/${result.id}/memory`)).notes.length, 0);
});

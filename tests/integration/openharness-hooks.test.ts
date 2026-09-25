import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Lifecycle hooks, the harness event feed and webhooks (#14), against the real stack and the fixture receiver.
// Hooks apply to the whole workspace, so every test removes the hooks it registers.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
const harness = `${base}/openharness/v1/harnesses/openharness`;
const receiver = (mode: string) => `http://fixtures:9090/receiver/${mode}`;
const suffix = randomUUID().slice(0, 8);
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let toolFlow: any, stepFlow: any;
const registered: string[] = [];

const session = () => ({ Cookie: cookie, Origin: base });
async function call(
  url: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = session(),
) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}
async function studio(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await call(`${base}/api${path}`, method, body);
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function hook(event: string, mode: string, extra: Record<string, unknown> = {}) {
  const r = await call(`${harness}/hooks`, 'POST', {
    event,
    handler: { type: 'webhook', url: receiver(mode) },
    ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  registered.push(r.data.hook.id);
  return r.data;
}
async function removeHooks() {
  while (registered.length) await call(`${harness}/hooks/${registered.pop()}`, 'DELETE');
}
async function execute(agentId: string, message: string) {
  const accepted = await call(`${harness}/execute`, 'POST', { message, agent_id: agentId });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
  for (let i = 0; i < 120; i++) {
    const r = await call(`${harness}/executions/${accepted.data.execution_id}`);
    if (['completed', 'failed', 'cancelled'].includes(r.data.execution.status)) {
      const run = await studio(`/runs/${accepted.data.execution_id}`);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Execution did not finish');
}
const receivedAt = async (mode: string) =>
  (await (await fetch(`${fixture}/receiver?mode=${mode}`)).json()) as any[];
const toolCalls = async () => ((await (await fetch(`${fixture}/stats`)).json()) as any).tools as number;

before(async () => {
  const status = await (await fetch(base + '/api/auth/status')).json();
  if (status.needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))!
      .slice('SETUP_TOKEN='.length);
    await call(
      `${base}/api/auth/setup`,
      'POST',
      { ...admin, name: 'Test Administrator', setupToken },
      { Origin: base },
    );
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(admin),
  });
  assert.equal(login.status, 200, 'Could not sign in to the isolated stack');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const provider = await studio('/providers', {
    name: `Hooks model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  const connection = await studio('/connections', {
    name: `Hook tools ${suffix}`,
    url: 'http://fixtures:9090/mcp',
  });
  await studio(`/connections/${connection.id}/discover`, {});
  toolFlow = await studio('/workflows', {
    name: `Hooked agent ${suffix}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'agent' },
      {
        id: 'agent',
        name: 'Agent',
        type: 'agent',
        prompt: '{{input}}',
        next: 'finish',
        config: { name: 'Agent', providerId: provider.id, systemPrompt: 'Use tools.' },
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
    resources: [{ id: 'tools', name: 'Tools', type: 'mcp', connectionId: connection.id, tools: ['lookup'] }],
    bindings: [{ agentNodeId: 'agent', resourceId: 'tools' }],
  });
  stepFlow = await studio('/workflows', {
    name: `Hooked step ${suffix}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'lookup' },
      {
        id: 'lookup',
        name: 'Lookup',
        type: 'tool',
        connectionId: connection.id,
        tool: 'lookup',
        arguments: { query: 'step' },
        next: 'finish',
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
  });
  await fetch(`${fixture}/receiver`, { method: 'DELETE' });
});
after(removeHooks);

test('the manifest reports hooks, and registration validates handlers and URLs', async () => {
  const caps = (await call(`${harness}/capabilities`)).data.capabilities;
  assert.equal(caps.hooks.supported, true);
  for (const op of ['pre-tool', 'post-tool', 'stop', 'events'])
    assert.ok(caps.hooks.operations.includes(op), op);
  const command = await call(`${harness}/hooks`, 'POST', {
    event: 'pre_tool',
    handler: { type: 'command', command: 'rm -rf /' },
  });
  assert.equal(command.data.error.code, 'COMMAND_HOOKS_UNSUPPORTED');
  const plainHttp = await call(`${harness}/hooks`, 'POST', {
    event: 'stop',
    handler: { type: 'webhook', url: 'http://example.com/hook' },
  });
  assert.equal(plainHttp.status, 400);
  const metadata = await call(`${harness}/hooks`, 'POST', {
    event: 'stop',
    handler: { type: 'webhook', url: 'https://169.254.169.254/latest' },
  });
  assert.equal(metadata.status, 400);
  const created = await hook('stop', 'allow');
  assert.match(created['x-openharness'].secret, /^whsec_/);
  const listed = (await call(`${harness}/hooks?event=stop`)).data.hooks;
  assert.ok(listed.some((h: any) => h.id === created.hook.id && h['x-openharness'].fail_mode === 'open'));
  assert.ok(!JSON.stringify(listed).includes(created['x-openharness'].secret), 'secrets are never listed');
  const updated = await call(`${harness}/hooks/${created.hook.id}`, 'PATCH', { enabled: false });
  assert.equal(updated.data.hook.enabled, false);
  await removeHooks();
  assert.equal((await call(`${harness}/hooks/${created.hook.id}`)).status, 404);
});

test('a pre_tool hook that denies stops the call before it reaches the tool', async () => {
  try {
    await hook('pre_tool', 'deny');
    const before = await toolCalls();
    const run = await execute(toolFlow.id, 'Please use tool now');
    assert.equal(run.status, 'succeeded', run.error);
    assert.match(run.output, /Blocked by a hook: fixture policy says no/);
    assert.equal(await toolCalls(), before, 'the MCP tool was never called');
    const decision = run.events.find((e: any) => e.type === 'hook');
    assert.equal(decision.data.decision, 'deny');
    const sent = (await receivedAt('deny')).at(-1);
    assert.equal(sent.body.event, 'pre_tool');
    assert.equal(sent.body.tool.name, 'lookup');
    assert.deepEqual(sent.body.tool.input, { query: 'orchestration test' });
    assert.equal(sent.body.execution_id, run.id);
  } finally {
    await removeHooks();
  }
});

test('hooks can rewrite tool input and output, and requests are signed', async () => {
  try {
    const modify = await hook('pre_tool', 'modify');
    await hook('post_tool', 'redact');
    const run = await execute(toolFlow.id, 'Please use tool again');
    assert.equal(run.status, 'succeeded', run.error);
    assert.match(run.output, /REDACTED by hook/);
    const started = run.events.find((e: any) => e.type === 'tool_started');
    assert.ok(started, 'the call was traced');
    const modifyRequest = (await receivedAt('modify')).at(-1);
    const redactRequest = (await receivedAt('redact')).at(-1);
    // The post_tool hook saw the output produced from the modified input.
    assert.equal(redactRequest.body.tool.input.query, 'modified by hook');
    assert.match(redactRequest.body.output.content, /MCP lookup: modified by hook/);
    const { raw, headers } = modifyRequest;
    const expected = `sha256=${createHmac('sha256', modify['x-openharness'].secret).update(`${headers['x-openharness-timestamp']}.${raw}`).digest('hex')}`;
    assert.equal(headers['x-openharness-signature'], expected);
    assert.equal(headers['x-openharness-event'], 'pre_tool');
  } finally {
    await removeHooks();
  }
});

test('an unreachable hook fails closed by default and open when configured', async () => {
  try {
    const closed = await hook('pre_tool', 'fail');
    const blocked = await execute(toolFlow.id, 'Please use tool while the hook is down');
    assert.match(blocked.output, /Blocked by a hook: A required hook could not be reached/);
    await call(`${harness}/hooks/${closed.hook.id}`, 'PATCH', { 'x-openharness': { fail_mode: 'open' } });
    const allowed = await execute(toolFlow.id, 'Please use tool with an optional hook');
    assert.match(allowed.output, /MCP lookup/);
    assert.ok(allowed.events.some((e: any) => e.type === 'hook' && e.data.decision === 'skipped'));
  } finally {
    await removeHooks();
  }
});

test('workflow tool steps honour hooks, and stop and error hooks are notified', async () => {
  try {
    await hook('pre_tool', 'deny');
    await hook('error', 'allow');
    await hook('stop', 'allow');
    const failed = await execute(stepFlow.id, 'go');
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /blocked by a hook/);
    await removeHooks();
    await hook('stop', 'allow');
    const ok = await execute(stepFlow.id, 'go');
    assert.equal(ok.status, 'succeeded', ok.error);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const notifications = await receivedAt('allow');
    const stop = notifications.find((r) => r.body.event === 'stop' && r.body.execution_id === ok.id);
    assert.equal(stop.body.status, 'succeeded');
    const error = notifications.find((r) => r.body.event === 'error' && r.body.execution_id === failed.id);
    assert.equal(error.body.status, 'failed');
  } finally {
    await removeHooks();
  }
});

test('the event feed lists and streams execution, hook and skill events', async () => {
  const since = new Date(Date.now() - 1000).toISOString();
  const controller = new AbortController();
  const streamed: string[] = [];
  const stream = fetch(`${harness}/events/stream?events=execution.started,execution.completed`, {
    headers: session(),
    signal: controller.signal,
  })
    .then(async (response) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (const match of buffer.matchAll(/event: (\S+)/g)) streamed.push(match[1]);
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 1);
      }
    })
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 700));
  const run = await execute(toolFlow.id, 'Hello events');
  await studio('/skills', {
    name: `Feed skill ${suffix}`,
    description: 'For the feed test.',
    instructions: 'Nothing.',
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  controller.abort();
  await stream;
  assert.ok(
    streamed.includes('execution.started') && streamed.includes('execution.completed'),
    streamed.join(','),
  );
  const completed = await call(
    `${harness}/events?type=execution.completed&since=${encodeURIComponent(since)}`,
  );
  const mine = completed.data.data.find((e: any) => e.data.execution_id === run.id);
  assert.equal(mine.data.status, 'completed');
  assert.match(mine.data.result_url, new RegExp(`/executions/${run.id}/result$`));
  const skills = await call(`${harness}/events?type=skill.installed&since=${encodeURIComponent(since)}`);
  assert.ok(skills.data.data.some((e: any) => e.data.name === `Feed skill ${suffix}`));
});

test('webhooks receive signed execution events', async () => {
  const created = await call(`${harness}/webhooks`, 'POST', {
    url: receiver('record'),
    events: ['execution.completed'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const secret = created.data.webhook.secret;
  try {
    const listed = (await call(`${harness}/webhooks`)).data.webhooks;
    assert.equal(listed.find((w: any) => w.id === created.data.webhook.id).secret, '********');
    const run = await execute(toolFlow.id, 'Hello webhook');
    let delivery: any;
    for (let i = 0; i < 40 && !delivery; i++) {
      delivery = (await receivedAt('record')).find((r) => r.body.execution_id === run.id);
      if (!delivery) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(delivery, 'the webhook was delivered');
    assert.equal(delivery.body.event, 'execution.completed');
    assert.equal(delivery.body.status, 'completed');
    const expected = `sha256=${createHmac('sha256', secret).update(`${delivery.headers['x-openharness-timestamp']}.${delivery.raw}`).digest('hex')}`;
    assert.equal(delivery.headers['x-openharness-signature'], expected);
  } finally {
    assert.equal((await call(`${harness}/webhooks/${created.data.webhook.id}`, 'DELETE')).status, 204);
  }
});

test('workflow keys cannot manage hooks or read the feed', async () => {
  const key = await studio('/integrations/tokens', {
    name: `Hooks key ${suffix}`,
    workflowIds: [toolFlow.id],
  });
  const auth = { Authorization: `Bearer ${key.token}` };
  assert.equal(
    (await call(`${harness}/hooks`, 'GET', undefined, auth)).data.error.code,
    'INSUFFICIENT_SCOPE',
  );
  assert.equal((await call(`${harness}/events`, 'GET', undefined, auth)).status, 403);
});

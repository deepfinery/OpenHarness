import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const oh = '/openharness/v1/harnesses/openharness';
let cookie = '',
  connectionId = '',
  providerId = '',
  userId = '';
async function raw(path: string, body?: unknown) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', Connection: 'close' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok(path: string, body?: unknown) {
  const r = await raw(path, body);
  const b = await r.json();
  assert.ok(r.ok, `${path}: ${JSON.stringify(b)}`);
  return b;
}
async function wait(id: string, status: string) {
  for (let i = 0; i < 160; i++) {
    const r = await ok(`/api/runs/${id}`);
    if (r.status === status) return r;
    assert.ok(!['failed', 'interrupted'].includes(r.status), JSON.stringify(r));
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Run ${id} did not reach ${status}`);
}
async function agent(extra: Record<string, unknown> = {}) {
  return ok('/api/agents', {
    name: 'Human regression',
    providerId,
    systemPrompt: 'Use tools and ask humans when needed.',
    maxTurns: 8,
    tokenBudget: 200000,
    connections: [{ connectionId, tools: ['lookup', 'file_resource'] }],
    ...extra,
  });
}
async function start(a: { id: string }, input: string) {
  return ok('/api/runs', { agentId: a.id, input });
}
async function requests(id: string) {
  return (await ok(`/api/inbox?runId=${id}`)).requests;
}
async function decide(id: string, decision: unknown) {
  return ok(`/api/inbox/${id}/decision`, decision);
}
before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  const r = await raw('/api/auth/login', credentials);
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie')!.split(';')[0];
  const isolated = { email: `human-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/api/users', { ...isolated, name: 'Human test', workspace: 'new' });
  const login = await raw('/api/auth/login', isolated);
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  userId = (await ok('/api/auth/me')).id;
  connectionId = (await ok('/api/connections', { name: 'Human tools', url: 'http://fixtures:9090/mcp' })).id;
  await ok(`/api/connections/${connectionId}/discover`, {});
  providerId = (
    await ok('/api/providers', {
      name: 'Human fixture',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-model',
      embeddingModel: 'test-embedding',
    })
  ).id;
});

test('question resumes after API and runner restart, without repeating prior effects, and exposes artifacts', async () => {
  const a = await agent();
  const run = await start(a, 'human checkpoint test');
  await wait(run.id, 'waiting_for_human');
  const [request] = await requests(run.id);
  assert.equal(request.kind, 'question');
  assert.equal(
    (await ok(`/api/runs/${run.id}/memory`)).notes.filter((n: any) => n.title === 'Before human pause')
      .length,
    1,
  );
  if (process.env.TEST_FAULT_INJECTION === 'true') {
    const project = process.env.TEST_COMPOSE_PROJECT!;
    assert.match(project, /^openharness-test-/);
    execFileSync(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        'compose.yaml',
        '-f',
        'tests/compose.test.yaml',
        ...(process.env.TEST_COMPOSE_OVERRIDE ? ['-f', process.env.TEST_COMPOSE_OVERRIDE] : []),
        'restart',
        'api',
        'runner',
      ],
      { stdio: 'pipe' },
    );
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + '/api/health')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await wait(run.id, 'waiting_for_human');
  const response = await ok(`${oh}/executions/${run.id}/input`, { data: 'Europe' });
  assert.equal(response.accepted, true);
  const finished = await wait(run.id, 'succeeded');
  assert.match(finished.output, /Europe/);
  assert.equal(finished.humanResumeCount, 1);
  assert.equal(
    finished.events.filter((e: any) => e.type === 'model').length,
    2,
    'the pending model response is reused',
  );
  assert.equal(
    (await ok(`/api/runs/${run.id}/memory`)).notes.filter((n: any) => n.title === 'Before human pause')
      .length,
    1,
  );
  assert.equal(
    (await raw(`/api/inbox/${request._id}/decision`, { decision: 'answer', answer: 'again' })).status,
    409,
  );
  assert.equal((await raw(`${oh}/executions/${run.id}/input`, { data: 'again' })).status, 410);
  const artifacts = (await ok(`${oh}/executions/${run.id}/artifacts`)).artifacts;
  assert.equal(artifacts.length, 1);
  const download = await raw(`${oh}/executions/${run.id}/artifacts/${artifacts[0].id}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), finished.output);
});

for (const choice of ['approve', 'deny'])
  test(`${choice} MCP call with editable validated arguments`, async () => {
    const a = await agent({ approvals: { mode: 'always' } });
    const run = await start(a, 'human approval test');
    await wait(run.id, 'waiting_for_human');
    const [request] = await requests(run.id);
    assert.equal(request.arguments.query, 'original approved query');
    assert.equal(
      (await raw(`/api/inbox/${request._id}/decision`, { decision: 'approve', arguments: { query: 3 } }))
        .status,
      400,
    );
    await decide(request._id, {
      decision: choice,
      ...(choice === 'approve'
        ? { arguments: { query: 'edited approved query' } }
        : { feedback: 'Do not run this' }),
    });
    const finished = await wait(run.id, 'succeeded');
    assert.match(finished.output, choice === 'approve' ? /edited approved query/ : /denied.*Do not run this/);
    assert.equal(
      (await ok(`/api/runs/${run.id}/memory`)).notes.filter((n: any) => n.title === 'Before tool approval')
        .length,
      1,
    );
  });

test('unauthorized approver cannot act, and cancellation invalidates pending input', async () => {
  const a = await agent({
    approvals: { approvers: { admins: false, owner: false, userIds: [randomUUID()] } },
  });
  const run = await start(a, 'human checkpoint test');
  const paused = await wait(run.id, 'waiting_for_human');
  assert.equal((await requests(run.id)).length, 0);
  const id = paused.events.find((e: any) => e.type === 'human_requested').data.requestId;
  assert.equal(
    (await raw(`/api/inbox/${id}/decision`, { decision: 'answer', answer: 'bypass' })).status,
    403,
  );
  await ok(`/api/runs/${run.id}/cancel`, {});
  await wait(run.id, 'cancelled');
  assert.equal((await raw(`${oh}/executions/${run.id}/input`, { data: 'bypass' })).status, 410);
});

test('delegated human pause keeps completed siblings and resumes the child without duplicate notes', async () => {
  const a = await agent({ delegation: { enabled: true, maxAgents: 3 } });
  const run = await start(a, 'human delegate test');
  await wait(run.id, 'waiting_for_human');
  const [request] = await requests(run.id);
  assert.notEqual(request.runId, run.id);
  await decide(request._id, { decision: 'answer', answer: 'North' });
  const finished = await wait(run.id, 'succeeded');
  assert.match(finished.output, /North/);
  assert.equal(
    finished.events.filter((e: any) => e.type === 'subagent_started').length,
    2,
    'only the paused child continues; no new child is spawned',
  );
  assert.equal(
    (await ok(`/api/runs/${run.id}/memory`)).notes.filter((n: any) => n.title === 'Before human pause')
      .length,
    1,
  );
});

test('workflow review edits result, chooses reject branch, and preserves attempt budget', async () => {
  for (const decision of ['approve', 'deny']) {
    const w = await ok('/api/workflows', {
      name: 'Review regression',
      startAt: 'review',
      nodes: [
        {
          id: 'review',
          name: 'Review',
          type: 'review',
          prompt: 'Accept this?',
          value: '{{last}}',
          onApprove: 'yes',
          onReject: 'no',
        },
        { id: 'yes', name: 'Approved', type: 'output', template: 'Approved: {{last}}' },
        { id: 'no', name: 'Rejected', type: 'output', template: 'Rejected' },
      ],
    });
    const run = await ok('/api/runs', { workflowId: w.id, input: 'Original' });
    await wait(run.id, 'waiting_for_human');
    const [r] = await requests(run.id);
    await decide(r._id, { decision, ...(decision === 'approve' ? { answer: 'Edited' } : {}) });
    const finished = await wait(run.id, 'succeeded');
    assert.equal(finished.output, decision === 'approve' ? 'Approved: Edited' : 'Rejected');
    assert.equal(finished.checkpoint.nodeAttempts.review, 1);
    assert.equal(finished.checkpoint.steps, 2);
  }
});

test('workflow tool approval resumes once and embedded resources download without fetching links', async () => {
  const w = await ok('/api/workflows', {
    name: 'Tool review',
    startAt: 'tool',
    approvals: { mode: 'always' },
    nodes: [
      {
        id: 'tool',
        name: 'File',
        type: 'tool',
        connectionId,
        tool: 'file_resource',
        arguments: {},
        next: 'end',
      },
      { id: 'end', name: 'End', type: 'output', template: 'Done' },
    ],
  });
  const run = await ok('/api/runs', { workflowId: w.id, input: 'file' });
  await wait(run.id, 'waiting_for_human');
  const [r] = await requests(run.id);
  await decide(r._id, { decision: 'approve' });
  await wait(run.id, 'succeeded');
  const artifacts = (await ok(`${oh}/executions/${run.id}/artifacts`)).artifacts;
  assert.equal(artifacts.length, 2);
  const file = artifacts.find((a: any) => a.name === 'result.txt');
  assert.ok(file);
  assert.equal(
    await (await raw(`${oh}/executions/${run.id}/artifacts/${file.id}`)).text(),
    'Artifact test bytes\n',
  );
});

test('parallel workflow members preserve completed work when another member asks a question', async () => {
  const question = await agent({ connections: [] });
  const sibling = await agent({ connections: [] });
  const w = await ok('/api/workflows', {
    name: 'Parallel human review',
    startAt: 'parallel',
    nodes: [
      {
        id: 'parallel',
        name: 'Parallel',
        type: 'parallel',
        agentIds: [],
        agentNodeIds: ['ask', 'sibling'],
        prompt: 'parallel human checkpoint',
        next: 'done',
      },
      {
        id: 'ask',
        name: 'Ask',
        type: 'agent',
        config: { ...question, id: undefined, systemPrompt: 'human-question-member', providerId },
        prompt: 'unused',
      },
      {
        id: 'sibling',
        name: 'Sibling',
        type: 'agent',
        config: { ...sibling, id: undefined, systemPrompt: 'Normal sibling.', providerId },
        prompt: 'unused',
      },
      { id: 'done', name: 'Done', type: 'output', template: '{{last}}' },
    ],
  });
  const run = await ok('/api/runs', { workflowId: w.id, input: 'parallel' });
  await wait(run.id, 'waiting_for_human');
  const [r] = await requests(run.id);
  await decide(r._id, { decision: 'answer', answer: 'Parallel North' });
  const finished = await wait(run.id, 'succeeded');
  assert.match(finished.output, /Parallel North/);
  assert.equal(finished.events.filter((e: any) => e.type === 'model').length, 4);
  assert.equal(
    (await ok(`/api/runs/${run.id}/memory`)).notes.filter(
      (n: any) => n.title === 'Completed parallel sibling',
    ).length,
    1,
  );
});

function mutateTestDatabase(script: string) {
  const project = process.env.TEST_COMPOSE_PROJECT!;
  assert.match(project, /^openharness-test-/);
  return execFileSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      'compose.yaml',
      '-f',
      'tests/compose.test.yaml',
      ...(process.env.TEST_COMPOSE_OVERRIDE ? ['-f', process.env.TEST_COMPOSE_OVERRIDE] : []),
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      `import {collection,mongo} from './dist/packages/core/src/db.js'; ${script}; await mongo.close();`,
    ],
    { encoding: 'utf8' },
  );
}
test(
  'expired tool requests deny safely and signed links reject tampering',
  { skip: process.env.TEST_FAULT_INJECTION !== 'true' },
  async () => {
    const a = await agent({ approvals: { mode: 'always', notifyEmail: true, timeoutSeconds: 60 } });
    const run = await start(a, 'human approval test');
    await wait(run.id, 'waiting_for_human');
    const [r] = await requests(run.id);
    assert.equal((await raw(`/api/inbox?requestId=${r._id}&token=${'0'.repeat(64)}`)).status, 410);
    mutateTestDatabase(
      `await collection('human_requests').updateOne({_id:${JSON.stringify(r._id)}},{$set:{expiresAt:new Date(0)}})`,
    );
    const decision = await raw(`/api/inbox/${r._id}/decision`, { decision: 'approve' });
    assert.equal(decision.status, 409);
    const finished = await wait(run.id, 'succeeded');
    assert.match(finished.output, /expired/);
    assert.equal(
      finished.events.filter((e: any) => e.type === 'tool_completed' && e.data?.tool === 'lookup').length,
      0,
    );
  },
);

test('simultaneous decisions accept one answer and reject the other', async () => {
  const a = await agent();
  const run = await start(a, 'human checkpoint test');
  await wait(run.id, 'waiting_for_human');
  const [r] = await requests(run.id);
  const results = await Promise.all(
    ['East', 'West'].map((answer) => raw(`/api/inbox/${r._id}/decision`, { decision: 'answer', answer })),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const finished = await wait(run.id, 'succeeded');
  assert.match(finished.output, /East|West/);
});

test(
  'gateway-enforced machine command approval uses the Inbox and cannot be bypassed by an agent policy',
  { skip: process.env.TEST_FAULT_INJECTION !== 'true' },
  async () => {
    const project = process.env.TEST_COMPOSE_PROJECT!;
    assert.match(project, /^openharness-test-/);
    const overlay = `test-results/human-gateway-${randomUUID()}.json`;
    const deviceId = `human-${randomUUID().slice(0, 8)}`;
    const files = [
      '-f',
      'compose.yaml',
      '-f',
      'tests/compose.test.yaml',
      ...(process.env.TEST_COMPOSE_OVERRIDE ? ['-f', process.env.TEST_COMPOSE_OVERRIDE] : []),
    ];
    const compose = (args: string[], extra: string[] = []) =>
      execFileSync('docker', ['compose', '-p', project, ...files, ...extra, ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    let container = '';
    try {
      await mkdir('test-results', { recursive: true });
      await writeFile(
        overlay,
        JSON.stringify({
          services: {
            gateway: {
              environment: { GATEWAY_APPROVAL_PROVIDER: 'studio', GATEWAY_APPROVAL_TOOLS: 'run_command' },
            },
          },
        }),
      );
      compose(['up', '-d', '--no-deps', '--no-build', '--wait', 'gateway'], ['-f', overlay]);
      const enrolled = await ok('/api/devices', {
        deviceId,
        name: 'Human approval machine',
        platform: 'linux',
        allowedTools: ['run_command', 'read_file', 'write_file'],
      });
      container = compose([
        'run',
        '-d',
        '--no-deps',
        '-e',
        `DEVICE_TOKEN=${enrolled.token}`,
        '-e',
        `DEVICE_ID=${deviceId}`,
        'device',
      ])
        .trim()
        .split('\n')
        .at(-1)!;
      for (let i = 0; i < 50; i++) {
        const machines = await ok('/api/devices');
        if (machines.machines.some((m: any) => m.device_id === deviceId && m.online && m.tools.length)) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const a = await agent({ connections: [], approvals: { mode: 'never' } });
      const run = await ok('/api/runs', {
        agentId: a.id,
        input: 'Please run uname on the machine',
        deviceId,
      });
      await wait(run.id, 'waiting_for_human');
      const [r] = await requests(run.id);
      assert.match(r.tool, /run_command/);
      assert.deepEqual(r.arguments.argv, ['uname', '-a']);
      await decide(r._id, { decision: 'approve' });
      const finished = await wait(run.id, 'succeeded');
      assert.match(finished.output, /Linux/);
      assert.equal(
        finished.events.filter((e: any) => e.type === 'tool_completed' && e.data?.tool === 'run_command')
          .length,
        1,
      );
      const files = await ok('/api/workflows', {
        name: 'Machine artifacts',
        startAt: 'write',
        nodes: [
          {
            id: 'write',
            name: 'Write',
            type: 'tool',
            connectionId: enrolled.machine.connectionId,
            tool: 'write_file',
            arguments: { path: 'human-artifact.txt', content: 'Machine artifact bytes' },
            next: 'read',
          },
          {
            id: 'read',
            name: 'Read',
            type: 'tool',
            connectionId: enrolled.machine.connectionId,
            tool: 'read_file',
            arguments: { path: 'human-artifact.txt' },
            next: 'done',
          },
          { id: 'done', name: 'Done', type: 'output', template: 'Files done' },
        ],
      });
      const fileRun = await ok('/api/runs', { workflowId: files.id, input: 'Capture files' });
      await wait(fileRun.id, 'succeeded');
      const artifacts = (await ok(`${oh}/executions/${fileRun.id}/artifacts`)).artifacts;
      assert.equal(artifacts.filter((a: any) => a.name === 'human-artifact.txt').length, 2);
    } finally {
      if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' });
      compose(['up', '-d', '--no-deps', '--no-build', '--wait', 'gateway']);
      await unlink(overlay).catch(() => {});
    }
  },
);

test('approval API enforces workspace scope and selected approvers', async () => {
  const a = await agent();
  const run = await start(a, 'human checkpoint test');
  await wait(run.id, 'waiting_for_human');
  const [r] = (await ok('/api/approvals')).requests.filter((r: any) => r.runId === run.id);
  assert.ok(r);
  const saved = cookie;
  const admin = await raw('/api/auth/login', {
    email: 'admin@openharness.test',
    password: 'Integration-test-password-42',
  });
  cookie = admin.headers.get('set-cookie')!.split(';')[0];
  try {
    assert.equal(
      (await raw(`/api/approvals/${r._id}`, { decision: 'answer', answer: 'wrong workspace' })).status,
      404,
    );
  } finally {
    cookie = saved;
  }
  await ok(`/api/approvals/${r._id}`, { decision: 'answer', answer: 'authorized' });
  await wait(run.id, 'succeeded');
});

test(
  'notifications use signed webhooks, email links, and notebook decision provenance',
  { skip: process.env.TEST_FAULT_INJECTION !== 'true' },
  async () => {
    const kb = await ok('/api/knowledge', { name: 'Human decision notebook', providerId });
    const a = await agent({ knowledgeBaseIds: [kb.id], approvals: { notifyEmail: true } });
    const hook = (
      await ok(`${oh}/webhooks`, {
        url: 'http://fixtures:9090/receiver/human',
        events: ['human.requested', 'human.decided'],
      })
    ).webhook;
    const run = await start(a, 'human checkpoint test');
    await wait(run.id, 'waiting_for_human');
    const [r] = await requests(run.id);
    let state: any;
    for (let i = 0; i < 30; i++) {
      state = JSON.parse(
        mutateTestDatabase(
          `const r=await collection('human_requests').findOne({_id:${JSON.stringify(r._id)}}); const {humanLinkToken}=await import('./dist/packages/core/src/human.js'); console.log(JSON.stringify({notifiedAt:r.notifiedAt,token:humanLinkToken(r)}))`,
        ),
      );
      if (state.notifiedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(state.notifiedAt, 'SMTP notification was delivered through the isolated JSON transport');
    assert.equal((await raw(`/api/inbox?requestId=${r._id}&token=${state.token}`)).status, 200);
    await decide(r._id, {
      decision: 'answer',
      answer: 'Notebook region',
      feedback: 'Remember this preference',
    });
    await wait(run.id, 'succeeded');
    let note: any;
    for (let i = 0; i < 40 && !note; i++) {
      note = (await ok(`/api/knowledge/${kb.id}/documents`)).find(
        (d: any) => d.meta?.human_request_id === r._id,
      );
      if (!note) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(note);
    assert.equal(note.meta.kind, 'decision');
    assert.equal(note.meta.actor, userId);
    let delivery: any;
    for (let i = 0; i < 30 && !delivery; i++) {
      const list = await (
        await fetch(`${process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090'}/receiver?mode=human`)
      ).json();
      delivery = list.find((d: any) => d.body.request_id === r._id && d.body.event === 'human.decided');
      if (!delivery) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(delivery);
    const expected =
      'sha256=' +
      createHmac('sha256', hook.secret)
        .update(`${delivery.headers['x-openharness-timestamp']}.${delivery.raw}`)
        .digest('hex');
    assert.equal(delivery.headers['x-openharness-signature'], expected);
  },
);

test('repeated pauses retain the original start time, budget counters and earlier effects', async () => {
  const a = await agent({ maxTurns: 3 });
  const run = await start(a, 'human repeated checkpoint');
  const first = await wait(run.id, 'waiting_for_human');
  let [r] = await requests(run.id);
  await decide(r._id, { decision: 'answer', answer: 'First answer' });
  await wait(run.id, 'waiting_for_human');
  [r] = await requests(run.id);
  assert.equal(r.prompt, 'Second question?');
  await decide(r._id, { decision: 'answer', answer: 'Second answer' });
  const finished = await wait(run.id, 'succeeded');
  assert.equal(finished.humanResumeCount, 2);
  assert.equal(finished.startedAt, first.startedAt);
  assert.equal(finished.events.filter((e: any) => e.type === 'model').length, 3);
  assert.match(finished.output, /Second answer/);
  assert.equal(
    (await ok(`/api/runs/${run.id}/memory`)).notes.filter((n: any) => n.title === 'Repeated pause evidence')
      .length,
    1,
  );
});

test(
  'concurrent artifact writers cannot exceed the per-run limit or cross workspace boundaries',
  { skip: process.env.TEST_FAULT_INJECTION !== 'true' },
  () => {
    const output = mutateTestDatabase(`
    import assert from 'node:assert/strict'; import {randomUUID} from 'node:crypto';
    import {recordArtifact,listArtifacts,artifactContent} from './dist/packages/core/src/artifacts.js';
    import {removeFile} from './dist/packages/core/src/storage.js';
    const ownerId=randomUUID(), runId=randomUUID(); await collection('runs').insertOne({_id:runId,ownerId,status:'running'});
    try {
      const writes=await Promise.all(Array.from({length:60},()=>recordArtifact(ownerId,runId,'bounded.txt','text/plain',Buffer.from('bounded'))));
      assert.equal(writes.filter(Boolean).length,50); assert.equal((await listArtifacts(ownerId,runId)).length,50);
      assert.equal((await listArtifacts(randomUUID(),runId)).length,0);
      assert.equal(await artifactContent(randomUUID(),runId,writes.find(Boolean)._id),undefined);
      assert.equal(await recordArtifact(ownerId,runId,'large','text/plain',Buffer.alloc(5*1024*1024+1)),undefined);
      console.log('artifact bounds verified');
    } finally {
      for(const a of await collection('artifacts').find({ownerId,runId}).toArray())await removeFile(a.storageKey);
      await collection('artifacts').deleteMany({ownerId,runId});await collection('runs').deleteOne({_id:runId,ownerId});
    }
  `);
    assert.match(output, /artifact bounds verified/);
  },
);

for (const choice of ['approve', 'deny'])
  test(`pending ${choice} remains binding after tool metadata changes`, async () => {
    const a = await agent({ approvals: { mode: 'when_risky' } });
    const run = await start(a, 'human approval test');
    await wait(run.id, 'waiting_for_human');
    const [r] = await requests(run.id);
    const change = (changed: boolean) =>
      fetch(`${process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090'}/human-tool-schema`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changed }),
      });
    try {
      await change(true);
      await decide(r._id, {
        decision: choice,
        ...(choice === 'approve'
          ? { arguments: { query: 'edited '.repeat(40) } }
          : { feedback: 'Do not execute' }),
      });
      const finished = await wait(run.id, 'succeeded');
      assert.match(finished.output, choice === 'approve' ? /no longer match/ : /denied.*Do not execute/);
      assert.equal(
        finished.events.filter((e: any) => e.type === 'tool_completed' && e.data?.tool === 'lookup').length,
        0,
      );
    } finally {
      await change(false);
    }
  });

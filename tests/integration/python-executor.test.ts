import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Python runs in the python-executor container: agents through run_python, harnesses through the Python step.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '';
let providerId = '';
let connectionId = '';
async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: response.status === 204 ? undefined : await response.json() };
}
async function ok(path: string, body?: unknown, method?: string) {
  const result = await request(path, body, method);
  assert.ok(result.status < 300, `${path}: ${result.status} ${JSON.stringify(result.data)}`);
  return result.data;
}
async function finished(id: string, timeoutMs = 300000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const run = await ok(`/runs/${id}`);
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Run did not finish');
}
const events = (run: any, type: string) => run.events.filter((e: any) => e.type === type);
const collections = (name: string, filter?: object) =>
  ok(
    `/mongodb/${connectionId}/collections/${name}/documents${filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : ''}`,
  );

before(async () => {
  const credentials = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup) {
    const setupToken = (await readFile('.env', 'utf8'))
      .split('\n')
      .find((line) => line.startsWith('SETUP_TOKEN='))!
      .slice(12);
    await ok('/auth/setup', { ...credentials, name: 'Test administrator', setupToken });
  }
  async function login(c: { email: string; password: string }) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  }
  await login(credentials);
  const isolated = { email: `python-${randomUUID()}@openharness.test`, password: credentials.password };
  await ok('/users', { ...isolated, name: 'Python executor', workspace: 'new' });
  await login(isolated);
  providerId = (
    await ok('/providers', {
      name: 'Python fixture',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-python',
      contextWindow: 200000,
      maxOutputTokens: 1024,
    })
  ).id;
  // The Collections tab's view of what the code writes.
  connectionId = (await ok('/connections', { name: 'MongoDB', kind: 'mongodb', builtIn: true, url: '' })).id;
});

test('an agent runs Python it wrote: the code reads its parameters, writes a collection and reports back', async () => {
  const agent = await ok('/agents', {
    name: 'Quant',
    providerId,
    systemPrompt: 'Analyse data with Python.',
    codeExecution: { enabled: true },
  });
  assert.equal((await ok(`/agents/${agent.id}`)).codeExecution.enabled, true);
  const run = await finished((await ok('/runs', { agentId: agent.id, input: 'python roundtrip' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /Python said:/);
  const started = events(run, 'tool_started').find((e: any) => e.data.tool === 'run_python');
  assert.ok(started, 'the run_python call is in the trace');
  assert.match(started.data.arguments, /write_df/);
  const completed = events(run, 'tool_completed').find((e: any) => e.data.tool === 'run_python');
  assert.ok(completed, JSON.stringify(events(run, 'tool_error')));
  const outcome = JSON.parse(completed.data.result);
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.exit_code, 0);
  assert.match(outcome.stdout, /mean close 3\.0/);
  assert.deepEqual(outcome.result.written, 5);
  assert.deepEqual(outcome.result.read, 5);
  assert.ok(outcome.result.collections.includes('python_prices'));
  // What the code wrote is the workspace's collection, visible in the Collections tab.
  const rows = await collections('python_prices', { ticker: 'AAPL' });
  assert.equal(rows.total, 5);
  assert.deepEqual(
    rows.documents.map((d: any) => d.close).sort((a: number, b: number) => a - b),
    [0, 1.5, 3, 4.5, 6],
  );
  // The run's jobs are listed without their code.
  const jobs = await ok(`/runs/${run.id}/jobs`);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'succeeded');
  assert.equal(jobs[0].code, undefined);
  assert.equal(jobs[0].purpose, 'roundtrip');
});

test('params_list runs one container per parameter set, in parallel', async () => {
  const agent = await ok('/agents', {
    name: 'Fan-out',
    providerId,
    systemPrompt: 'Compute.',
    codeExecution: { enabled: true },
  });
  const run = await finished((await ok('/runs', { agentId: agent.id, input: 'python fan-out' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /Fan-out finished: 4,9,16/);
  const jobs = await ok(`/runs/${run.id}/jobs`);
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((j: any) => j.status === 'succeeded'));
  // Three jobs ran together: the latest start is before the earliest finish.
  const starts = jobs.map((j: any) => Date.parse(j.startedAt));
  const ends = jobs.map((j: any) => Date.parse(j.finishedAt));
  assert.ok(Math.max(...starts) < Math.min(...ends), `starts=${starts} ends=${ends}`);
  const squares = await collections('python_squares');
  assert.deepEqual(
    squares.documents.map((d: any) => d.square).sort((a: number, b: number) => a - b),
    [4, 9, 16],
  );
});

test('a failing script comes back as an error with its output, not as a crashed run', async () => {
  const agent = await ok('/agents', {
    name: 'Fallible',
    providerId,
    systemPrompt: 'Try.',
    codeExecution: { enabled: true },
  });
  const run = await finished((await ok('/runs', { agentId: agent.id, input: 'python failure' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  const failed = events(run, 'tool_error').find((e: any) => e.data.tool === 'run_python');
  assert.ok(failed, 'the failure is a tool error');
  const outcome = JSON.parse(failed.data.result);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exit_code, 3);
  assert.match(outcome.stdout, /about to fail/);
  assert.match(run.output, /"status":"failed"/);
});

test('agents without the setting are not offered the tool', async () => {
  const agent = await ok('/agents', { name: 'Plain', providerId, systemPrompt: 'Chat.' });
  const run = await finished((await ok('/runs', { agentId: agent.id, input: 'python roundtrip' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  assert.match(run.output, /NO PYTHON TOOL/);
  assert.deepEqual(await ok(`/runs/${run.id}/jobs`), []);
});

test('a Python harness step runs with templated parameters and hands its result to the next step', async () => {
  const harness = await ok('/workflows', {
    name: 'ETL',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'load' },
      {
        id: 'load',
        type: 'code',
        name: 'Load prices',
        params: { ticker: '{{payload.ticker}}', days: 4 },
        code: [
          'import oh, pandas as pd',
          'days = int(oh.params["days"])',
          'frame = pd.DataFrame({"ticker": [oh.params["ticker"]] * days, "day": list(range(days)), "close": [100 + d for d in range(days)]})',
          'oh.write_df("etl_prices", frame, mode="replace")',
          'oh.result({"ticker": oh.params["ticker"], "rows": days, "last_close": 100 + days - 1})',
        ].join('\n'),
        next: 'features',
      },
      {
        id: 'features',
        type: 'code',
        name: 'Moving average',
        params: { ticker: '{{steps.load.ticker}}', window: 2 },
        code: [
          'import oh',
          'rows = oh.read_df("etl_prices", {"ticker": oh.params["ticker"]}, sort=[("day", 1)])',
          'rows["ma"] = rows["close"].rolling(int(oh.params["window"])).mean()',
          'oh.write_df("etl_features", rows[["ticker", "day", "ma"]].dropna(), mode="replace")',
          'print("features", len(rows.dropna()))',
          'oh.result({"features": int(rows["ma"].notna().sum()), "last_ma": float(rows["ma"].iloc[-1])})',
        ].join('\n'),
        next: 'finish',
      },
      { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
    ],
  });
  const run = await finished(
    (await ok('/runs', { workflowId: harness.id, input: 'etl', payload: { ticker: 'MSFT' } })).id,
  );
  assert.equal(run.status, 'succeeded', run.error);
  assert.deepEqual(JSON.parse(run.output), { features: 3, last_ma: 102.5 });
  const load = events(run, 'node_completed').find((e: any) => e.nodeId === 'load');
  assert.match(load.data.output, /"rows":4/);
  const features = await collections('etl_features', { ticker: 'MSFT' });
  assert.equal(features.total, 3);
  assert.deepEqual(
    features.documents.map((d: any) => d.ma).sort((a: number, b: number) => a - b),
    [100.5, 101.5, 102.5],
  );
  const jobs = await ok(`/runs/${run.id}/jobs`);
  assert.deepEqual(jobs.map((j: any) => j.nodeId).sort(), ['features', 'load']);
});

test('a Python step that fails stops the run with the error', async () => {
  const harness = await ok('/workflows', {
    name: 'Broken ETL',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'bad' },
      {
        id: 'bad',
        type: 'code',
        name: 'Bad step',
        code: 'raise RuntimeError("no data for " + "XYZ")',
        next: 'finish',
      },
      { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
    ],
  });
  const run = await finished((await ok('/runs', { workflowId: harness.id, input: 'etl' })).id);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Bad step: The code exited with status 1/);
  assert.match(run.error, /RuntimeError: no data for XYZ/);
});

test('one workspace cannot read another workspace’s collections from Python', async () => {
  // A second workspace writes a secret collection; the first workspace's code cannot see it.
  const first = cookie;
  const other = {
    email: `python-other-${randomUUID()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await ok('/users', { ...other, name: 'Other', workspace: 'new' });
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(other),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const otherConnection = await ok('/connections', {
    name: 'MongoDB',
    kind: 'mongodb',
    builtIn: true,
    url: '',
  });
  await ok(`/mongodb/${otherConnection.id}/collections/secrets/documents`, {
    documents: [{ token: 'hidden' }],
  });
  const otherDatabase = (await ok(`/mongodb/${otherConnection.id}/collections`)).database;
  cookie = first;
  const harness = await ok('/workflows', {
    name: 'Peek',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'peek' },
      {
        id: 'peek',
        type: 'code',
        name: 'Peek',
        params: { other: otherDatabase },
        code: [
          'import oh, os',
          'from pymongo import MongoClient',
          'client = MongoClient(os.environ["MONGODB_URI"])',
          'try:',
          '    list(client[oh.params["other"]]["secrets"].find())',
          '    other = "readable"',
          'except Exception as error:',
          '    other = type(error).__name__',
          'try:',
          '    list(client["agentic"]["users"].find())',
          '    app = "readable"',
          'except Exception as error:',
          '    app = type(error).__name__',
          'oh.result({"own": oh.collections(), "other": other, "app": app})',
        ].join('\n'),
        next: 'finish',
      },
      { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
    ],
  });
  const run = await finished((await ok('/runs', { workflowId: harness.id, input: 'peek' })).id);
  assert.equal(run.status, 'succeeded', run.error);
  const result = JSON.parse(run.output);
  assert.equal(result.other, 'OperationFailure');
  assert.equal(result.app, 'OperationFailure');
  assert.ok(!result.own.includes('secrets'));
});

test('Python secrets reach only the steps that list them, can be copied from a connection, and are never returned', async () => {
  await ok('/executor/secrets/DEMO_TOKEN', { value: 'typed-secret-value-123' }, 'PUT');
  // A connection whose URL carries the key: copied server-side, never typed again.
  const connection = await ok('/connections', {
    name: 'Keyed API',
    url: 'http://fixtures:9090/mcp?apikey=from-connection-456',
  });
  const imported = await ok(
    '/executor/secrets/KEYED_API_KEY',
    { connectionId: connection.id, queryParam: 'apikey' },
    'PUT',
  );
  assert.deepEqual(imported.source, {
    connectionId: connection.id,
    connectionName: 'Keyed API',
    queryParam: 'apikey',
  });
  const listed = await ok('/executor/secrets');
  assert.deepEqual(
    listed.map((s: any) => s.name),
    ['DEMO_TOKEN', 'KEYED_API_KEY'],
  );
  assert.ok(!JSON.stringify(listed).includes('typed-secret-value-123'), 'values are never listed');
  assert.ok(!JSON.stringify(listed).includes('from-connection-456'));
  const probe = [
    'import os, oh',
    'oh.result({name: os.environ.get(name) for name in ["DEMO_TOKEN", "KEYED_API_KEY"]})',
  ].join('\n');
  const harness = (secrets: string[]) =>
    ok('/workflows', {
      name: `Secrets ${secrets.join('+') || 'none'}`,
      startAt: 'start',
      nodes: [
        { id: 'start', type: 'start', name: 'Start', next: 'probe' },
        { id: 'probe', type: 'code', name: 'Probe', code: probe, secrets, next: 'finish' },
        { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
      ],
    });
  const both = await finished(
    (await ok('/runs', { workflowId: (await harness(['DEMO_TOKEN', 'KEYED_API_KEY'])).id, input: 'x' })).id,
  );
  assert.equal(both.status, 'succeeded', both.error);
  assert.deepEqual(JSON.parse(both.output), {
    DEMO_TOKEN: 'typed-secret-value-123',
    KEYED_API_KEY: 'from-connection-456',
  });
  const none = await finished((await ok('/runs', { workflowId: (await harness([])).id, input: 'x' })).id);
  assert.deepEqual(JSON.parse(none.output), { DEMO_TOKEN: null, KEYED_API_KEY: null });
  const missing = await finished(
    (await ok('/runs', { workflowId: (await harness(['NOT_THERE'])).id, input: 'x' })).id,
  );
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /Missing secrets: NOT_THERE/);
  await ok('/executor/secrets/DEMO_TOKEN', undefined, 'DELETE');
  assert.deepEqual(
    (await ok('/executor/secrets')).map((s: any) => s.name),
    ['KEYED_API_KEY'],
  );
});

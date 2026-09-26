import { OpenHarnessAdapter } from '../../packages/openharness-client/index.js';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import WebSocket from 'ws';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:18088',
  root = base + '/openharness/v1';
const suffix = randomUUID().slice(0, 8);
let cookie = '',
  hid = '',
  aid = '',
  provider = '',
  other = '';
const headers = () => ({ Cookie: cookie, Origin: base });
async function call(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(path.startsWith('/api') ? base + path : root + path, {
    method,
    headers: { ...headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}
const h = (path = '') => `/harnesses/${hid}${path}`;
async function ok(path: string, method = 'GET', body?: unknown) {
  const r = await call(path, method, body);
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function multipart(
  path: string,
  files: Record<string, string>,
  fields: Record<string, string> = {},
  zip?: { field: string; bytes: Buffer },
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const [name, content] of Object.entries(files)) form.append('files', new Blob([content]), name);
  if (zip) form.append(zip.field, new Blob([new Uint8Array(zip.bytes)]), 'bundle.zip');
  const r = await fetch(root + path, { method: 'POST', headers: headers(), body: form });
  return { status: r.status, data: await r.json() };
}
before(async () => {
  const auth = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await (await fetch(base + '/api/auth/status')).json()).needsSetup) {
    const env = await readFile('.env', 'utf8'),
      setupToken = env
        .split('\n')
        .find((l) => l.startsWith('SETUP_TOKEN='))!
        .slice(12);
    await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...auth, name: 'Test Administrator', setupToken }),
    });
  }
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify(auth),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  provider = (
    await ok('/api/providers', 'POST', {
      name: `API fixture ${suffix}`,
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
      model: 'test-model',
      embeddingModel: 'test-embed',
    })
  ).id;
  // Make provider resolution deterministic for agent creation.
  await ok('/api/tenant', 'PUT', { providerId: provider });
  hid = (
    await ok('/harnesses', 'POST', {
      name: `Harness ${suffix}`,
      description: 'API coverage',
      execution_type: 'hosted',
      config: {},
    })
  ).harness.id;
  other = (
    await ok('/harnesses', 'POST', {
      name: `Other ${suffix}`,
      description: 'Scope isolation',
      execution_type: 'hosted',
      config: {},
    })
  ).harness.id;
  aid = (
    await ok(h('/agents'), 'POST', {
      metadata: { name: `Agent ${suffix}`, description: 'Answer briefly' },
      files: [],
    })
  ).agent.id;
});
test('harness registry and studio alias preserve identities; agent edits affect its node', async () => {
  const list = await ok('/harnesses');
  assert.ok(list.data.some((r: any) => r.id === hid));
  const studio = await ok('/api/harnesses/' + hid);
  assert.equal(studio.id, hid);
  assert.ok(studio.nodes.some((n: any) => n.id === aid));
  await ok(h('/agents/' + aid), 'PATCH', { config: { system_prompt: 'Reply clearly.', model: provider } });
  const got = await ok(h('/agents/' + aid));
  assert.equal(got.agent.config.system_prompt, 'Reply clearly.');
  assert.equal((await call(`/harnesses/${other}/agents/${aid}`)).status, 404);
  const renamed = await ok(h(), 'PATCH', { name: `Renamed ${suffix}` });
  assert.equal(renamed.harness.name, `Renamed ${suffix}`);
  const run = await ok(h('/execute'), 'POST', {
    agent_id: aid,
    message: 'What is 7 * 8? Reply with just the number.',
  });
  assert.ok(run.execution_id);
  assert.ok(run.stream_url.includes(`/harnesses/${hid}/`));
  assert.equal((await call(`/harnesses/${other}/executions/${run.execution_id}`)).status, 404);
});
test('MCP API discovers real tools, resources and prompts and redacts credentials', async () => {
  const connected = await ok(h('/mcp-servers'), 'POST', {
    name: `MCP ${suffix}`,
    transport: { type: 'http', url: 'http://fixtures:9090/mcp' },
  });
  const id = connected.server.id;
  assert.equal(connected.server.status, 'connected');
  const tools = await ok(h(`/mcp-servers/${id}/tools`));
  assert.ok(tools.tools.length > 0);
  assert.ok(tools.tools.every((t: any) => t.input_schema));
  assert.ok(
    (await ok(h(`/mcp-servers/${id}/resources`))).resources.some((r: any) => r.uri === 'fixture://report'),
  );
  assert.ok(Array.isArray((await ok(h(`/mcp-servers/${id}/prompts`))).prompts));
  assert.equal((await ok(h(`/mcp-servers/${id}/health`), 'POST', {})).status, 'healthy');
  await ok(h(`/mcp-servers/${id}`), 'PATCH', { name: `Changed ${suffix}` });
  await ok(h(`/mcp-servers/${id}`), 'DELETE');
  assert.equal((await ok(h(`/mcp-servers/${id}`))).server.status, 'disconnected');
});
test('skill manifests validate, upgrade, rollback and download with supporting files', async () => {
  const name = `skill-${suffix}`,
    manifest = (version: string) =>
      `---\nname: ${name}\ndescription: A test skill\nversion: ${version}\n---\n\nFollow the test instructions ${version}.`;
  const valid = await multipart(h('/skills/validate'), { 'SKILL.md': manifest('1.0.0') });
  assert.equal(valid.data.valid, true);
  const created = await multipart(
    h('/skills'),
    { 'SKILL.md': manifest('1.0.0'), 'notes.txt': 'Helpful context' },
    { metadata: JSON.stringify({ display_title: 'API skill' }) },
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.skill.id;
  const upgraded = await multipart(h(`/skills/${id}/upgrade`), { 'SKILL.md': manifest('1.1.0') });
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.data.skill.version, '1.1.0');
  assert.equal((await ok(h(`/skills/${id}/versions`))).versions.length, 2);
  const rollback = await ok(h(`/skills/${id}/rollback`), 'POST', { version: '1.0.0' });
  assert.equal(rollback.skill.version, '1.0.0');
  const download = await fetch(root + h(`/skills/${id}/download`), { headers: headers() });
  assert.equal(download.status, 200);
  const zip = await JSZip.loadAsync(await download.arrayBuffer());
  assert.equal(await zip.file('notes.txt')!.async('string'), 'Helpful context');
  const invalid = await multipart(h('/skills/validate'), { 'other.md': 'no manifest' });
  assert.equal(invalid.data.valid, false);
  const studio = await ok(`/api/skills/${id}`);
  await ok(`/api/skills/${id}`, 'PUT', { ...studio, instructions: 'Updated through studio' });
  const versioned = await ok(h(`/skills/${id}/versions`));
  assert.equal(versioned.current_version, '1.0.1');
  assert.equal(versioned.versions.length, 3);
  const updated = await fetch(root + h(`/skills/${id}/download`), { headers: headers() });
  const updatedZip = await JSZip.loadAsync(await updated.arrayBuffer());
  assert.equal(await updatedZip.file('notes.txt')!.async('string'), 'Helpful context');
  await ok(h(`/skills/${id}`), 'DELETE');
});
test('workspace files enforce scope and traversal, preserve binary uploads, search and zip downloads', async () => {
  const put = await fetch(root + h('/files/reports/result.txt'), {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'text/plain' },
    body: 'first line\nGPU report',
  });
  assert.equal(put.status, 200, await put.text());
  assert.equal((await call(`/harnesses/${other}/files/reports/result.txt`)).status, 404);
  assert.equal((await ok(h('/files?recursive=true'))).files.length, 2);
  const search = await ok(h('/files/search'), 'POST', { glob: '**/*.txt', grep: 'GPU' });
  assert.equal(search.matches[0].line_matches[0].line_number, 2);
  assert.equal((await call(h('/files/reports'), 'DELETE')).status, 409);
  const escape = await multipart(h('/files/upload'), { 'safe.txt': 'x' }, { path: '../outside.txt' });
  assert.equal(escape.status, 400);
  const zip = await fetch(root + h('/files/download-batch'), {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: ['reports/result.txt'] }),
  });
  assert.equal(zip.status, 200);
  const archive = await JSZip.loadAsync(await zip.arrayBuffer());
  assert.equal(await archive.file('reports/result.txt')!.async('string'), 'first line\nGPU report');
  await ok(h('/files/reports?recursive=true'), 'DELETE');
  assert.equal((await call(h('/files/reports/result.txt'))).status, 404);
});
test('memory blocks respect read-only constraints and survive export/import without archive duplicates', async () => {
  const path = h(`/agents/${aid}/memory`);
  await ok(path + '/blocks', 'POST', { label: 'preferences', value: 'Prefer concise summaries' });
  await ok(path + '/blocks', 'POST', { label: 'immutable', value: 'Read only', read_only: true });
  assert.equal((await call(path + '/blocks/immutable', 'PUT', { value: 'changed' })).status, 409);
  await ok(path + '/archive', 'POST', { content: 'GPU incident resolved', metadata: { source: 'test' } });
  await ok(path + '/archive', 'POST', { content: 'GPU incident resolved' });
  assert.equal((await ok(path + '/archive')).total, 1);
  assert.equal((await ok(path + '/search', 'POST', { query: 'GPU' })).results[0].source, 'archive');
  const response = await fetch(root + path + '/export', {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  await ok(path + '/blocks/preferences', 'PUT', { value: 'Changed' });
  const imported = await multipart(path + '/import', {}, {}, { field: 'snapshot', bytes });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.archive_entries_imported, 0);
  assert.equal((await ok(path + '/blocks/preferences')).block.value, 'Prefer concise summaries');
});
test('sessions persist turns, fork history, reject cross-harness access and exchange WebSocket messages', async () => {
  const created = await ok(h('/sessions'), 'POST', { agent_id: aid, name: 'Conversation' });
  const id = created.session.id;
  const answer = await ok(h(`/sessions/${id}/message`), 'POST', {
    content: 'What is 7 * 8? Reply with just the number.',
  });
  assert.ok(answer.response.content.includes('56'));
  const history = await ok(h(`/sessions/${id}/history`));
  assert.equal(history.total, 2);
  const fork = await ok(h(`/sessions/${id}/fork`), 'POST', {
    from_message_id: history.data[0].id,
    new_name: 'Fork',
  });
  assert.equal(fork.message_count, 1);
  assert.equal((await call(`/harnesses/${other}/sessions/${id}`)).status, 404);
  await ok(h(`/sessions/${id}`), 'PATCH', { status: 'paused' });
  assert.equal((await call(h(`/sessions/${id}/message`), 'POST', { content: 'Hello' })).status, 409);
  await ok(h(`/sessions/${id}/resume`), 'POST', {});
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(created.connect_url, { headers: headers() });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket timed out'));
    }, 20000);
    let text = '';
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'message', id: 'test-turn', content: 'Count from 1 to 3' })),
    );
    ws.on('error', reject);
    ws.on('message', (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'text') text += event.content;
      if (event.type === 'done') {
        clearTimeout(timer);
        ws.close();
        try {
          assert.ok(text.includes('1'));
          resolve();
        } catch (e) {
          reject(e);
        }
      }
      if (event.type === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(new Error(event.message));
      }
    });
  });
  await ok(h(`/sessions/${id}`), 'DELETE');
  assert.equal((await call(h(`/sessions/${id}/resume`), 'POST', {})).status, 409);
});
test('subagent delegation has a bounded inherited configuration and a retrievable result', async () => {
  const path = h(`/agents/${aid}/subagents`);
  const child = await ok(path, 'POST', { name: 'Child', description: 'Do arithmetic' });
  const id = child.subagent.id;
  const delegated = await ok(path + `/${id}/delegate`, 'POST', {
    task: 'What is 7 * 8? Reply with just the number.',
  });
  assert.ok(delegated.execution_id);
  const execution = await ok(h(`/executions/${delegated.execution_id}`));
  assert.equal(execution.execution['x-openharness'].subagent_id, id);
  assert.equal((await call(`/harnesses/${other}/executions/${delegated.execution_id}`)).status, 404);
  let result;
  for (let i = 0; i < 80; i++) {
    result = await call(path + `/${id}/result`);
    if (result.status !== 409) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(result!.status, 200, JSON.stringify(result));
  assert.ok(result!.data.result.output.includes('56'));
  const events = await fetch(root + path + `/${id}/stream`, { headers: headers() });
  assert.equal(events.status, 200);
  const streamed = await events.text();
  assert.match(streamed, /event: done/);
  assert.match(streamed, /56/);
  await ok(path + `/${id}`, 'DELETE');
});
test('OpenAPI describes actual domains and diagnostic results avoid exposing prompts or secrets', async () => {
  const doc = await ok('/openapi.json');
  assert.equal(doc.openapi, '3.0.3');
  assert.ok(doc.paths['/harnesses/{harnessId}/sessions/{sessionId}/message']);
  for (const d of Object.values(doc['x-openharness-capabilities']) as any[]) assert.equal(d.supported, true);
  const r = await ok(h('/conformance/run'), 'POST', { quick: true });
  assert.equal(r.status, 'completed');
  const status = await ok(h('/conformance/status'));
  assert.equal(status.status, 'partial');
  const diag = await ok(h('/diagnostics'));
  assert.equal(diag.harness_id, hid);
  const logs = await ok(h('/logs'));
  assert.ok(logs.data.every((r: any) => !r.message.includes('Reply with')));
});

test('agents write persistent core memory and workspace files through runtime tools', async () => {
  const execute = async (message: string) => {
    const started = await ok(h('/execute'), 'POST', { agent_id: aid, message });
    let r: any;
    for (let i = 0; i < 100; i++) {
      r = await call(h(`/executions/${started.execution_id}/result`));
      if (r.status !== 409) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.result.output as string;
  };
  await execute('API core memory write');
  assert.equal(
    (await ok(h(`/agents/${aid}/memory/blocks/runtime-note`))).block.value,
    'Remembered from an earlier execution',
  );
  assert.equal(await execute('API core memory recall'), 'Persistent memory recalled');
  await execute('API workspace write');
  assert.equal((await call(h('/files/agent/report.txt'))).data, 'Written by the agent');
});
test('plan edits apply to pending steps during a real execution', async () => {
  const p = await ok('/api/providers', 'POST', {
    name: `Planner ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-api-plan',
  });
  const w = await ok('/api/harnesses/' + hid);
  const n = w.nodes.find((n: any) => n.id === aid);
  n.config.pattern = 'plan-execute';
  n.config.providerId = p.id;
  await ok('/api/harnesses/' + hid, 'PUT', w);
  const started = await ok(h('/execute'), 'POST', { agent_id: aid, message: 'Research this two-step task' });
  let plan: any;
  for (let i = 0; i < 100; i++) {
    const r = await call(h(`/executions/${started.execution_id}/plan`));
    if (r.status === 200 && r.data.plan.tasks[0].status === 'in_progress') {
      plan = r.data.plan;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(plan);
  const path = h(`/executions/${started.execution_id}/plan/tasks/`);
  assert.equal(
    (await call(path + plan.tasks[0].id, 'PATCH', { content: 'Change running task' })).status,
    409,
  );
  await ok(path + plan.tasks[1].id, 'PATCH', { content: 'Include the revised GPU checklist' });
  let final: any;
  for (let i = 0; i < 120; i++) {
    const r = await call(h(`/executions/${started.execution_id}/result`));
    if (r.status === 200) {
      final = r.data;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(final);
  const finished = await ok(h(`/executions/${started.execution_id}/plan`));
  assert.ok(finished.plan.tasks.every((t: any) => t.status === 'completed'));
  assert.equal(finished.plan.tasks[1].content, 'Include the revised GPU checklist');
  const run = await ok('/api/runs/' + started.execution_id);
  assert.ok(
    run.events.some((e: any) => e.type === 'plan_step' && e.message.includes('revised GPU checklist')),
  );
});

test('agent clone and OAF roundtrip preserve valid graph connections', async () => {
  const cloned = await ok(h(`/agents/${aid}/clone`), 'POST', { new_name: `Clone ${suffix}` });
  const id = cloned.agent.id;
  const graph = await ok('/api/harnesses/' + hid);
  assert.equal(graph.nodes.find((n: any) => n.id === aid).next, id);
  const exported = await fetch(root + h(`/agents/${id}/export`), { headers: headers() });
  assert.equal(exported.status, 200);
  const bytes = Buffer.from(await exported.arrayBuffer());
  const imported = await multipart(
    h('/agents/import'),
    {},
    { rename_to: `Imported ${suffix}` },
    { field: 'bundle', bytes },
  );
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  await ok(h(`/agents/${imported.data.agent.id}`), 'DELETE');
  await ok(h(`/agents/${id}`), 'DELETE');
});
test('workspace keys, scoped keys and other tenants cannot cross resource boundaries', async () => {
  const scoped = await ok('/api/integrations/tokens', 'POST', {
    name: `Scope ${suffix}`,
    workflowIds: [hid],
  });
  const read = async (path: string) =>
    fetch(root + path, { headers: { Authorization: `Bearer ${scoped.token}` } });
  assert.equal((await read(h('/agents'))).status, 200);
  assert.equal((await read(`/harnesses/${other}/agents`)).status, 404);
  assert.equal((await read(h('/skills'))).status, 403);
  const email = `api-outsider-${suffix}@openharness.test`,
    password = 'Api-outsider-password-42';
  await ok('/api/users', 'POST', { name: 'API outsider', email, password, workspace: 'new' });
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const stranger = login.headers.get('set-cookie')!.split(';')[0];
  for (const path of [h('/agents'), h('/files'), h(`/agents/${aid}/memory`), h('/sessions'), h('/logs')])
    assert.equal((await fetch(root + path, { headers: { Cookie: stranger } })).status, 404);
});
test('TypeScript adapter executes the advertised contract and consumes streamed results', async () => {
  const key = await ok('/api/integrations/tokens', 'POST', { name: `SDK ${suffix}`, scopes: ['harness'] });
  const adapter = new OpenHarnessAdapter({ baseUrl: root, apiKey: key.token, harnessId: hid });
  assert.ok((await adapter.listAgents()).some((a: any) => a.id === aid));
  assert.ok((await adapter.getCapabilityManifest()).memory.supported);
  await adapter.writeFile('sdk.txt', 'Adapter roundtrip');
  assert.equal(
    Buffer.from((await adapter.readFile('sdk.txt')) as ArrayBuffer).toString(),
    'Adapter roundtrip',
  );
  await adapter.deleteFile('sdk.txt');
  const result = await adapter.execute({
    agent_id: aid,
    message: 'What is 7 * 8? Reply with just the number.',
  });
  assert.ok(result.output.length);
  assert.ok(result.usage);
});

test('file batch limits, binary fidelity and regex validation apply before storage', async () => {
  const uploaded = await multipart(
    h('/files/upload-batch'),
    { 'first.txt': 'alpha GPU', 'second.txt': 'beta' },
    { base_path: 'batch', overwrite: 'true' },
  );
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.data.uploaded.length, 2);
  assert.equal(
    (await ok(h('/files/search'), 'POST', { glob: '**/*.txt', grep: '^alpha.*GPU$' })).matches.length,
    1,
  );
  assert.equal((await call(h('/files/search'), 'POST', { grep: '(unclosed' })).status, 400);
  const tooBig = await fetch(root + h('/files/oversize.bin'), {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(10 * 1024 * 1024 + 1),
  });
  assert.equal(tooBig.status, 413);
  assert.equal((await call(h('/files/oversize.bin'))).status, 404);
  const bytes = new Uint8Array([0, 255, 13, 10, 128]);
  const form = new FormData();
  form.set('path', 'batch/data.bin');
  form.append('file', new Blob([bytes]), 'data.bin');
  const put = await fetch(root + h('/files/upload'), { method: 'POST', headers: headers(), body: form });
  assert.equal(put.status, 200);
  const file = await fetch(root + h('/files/batch/data.bin'), { headers: headers() });
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  assert.match(file.headers.get('content-security-policy')!, /sandbox/);
  await ok(h('/files/batch?recursive=true'), 'DELETE');
});
test('session execution retries are idempotent and retain the chosen agent', async () => {
  const session = await ok(h('/sessions'), 'POST', { agent_id: aid });
  const post = async (message: string) =>
    fetch(root + h('/execute'), {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json', 'Idempotency-Key': 'session-retry' },
      body: JSON.stringify({ message, session_id: session.session.id, agent_id: aid }),
    });
  const first = await post('What is 7 * 8? Reply with just the number.');
  assert.equal(first.status, 202);
  const run = await first.json();
  const retry = await post('What is 7 * 8? Reply with just the number.');
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).execution_id, run.execution_id);
  assert.equal((await post('different request')).status, 409);
});

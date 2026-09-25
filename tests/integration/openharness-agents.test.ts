import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { parse } from 'yaml';

// Open Harness agents (#3) and tools (#4) on the real stack: OAF create/import/export, update, clone, delete,
// tool listing and direct invocation.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const harness = `${base}/openharness/v1/harnesses/openharness`;
const suffix = randomUUID().slice(0, 8);
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let provider: any, connection: any;

const session = () => ({ Cookie: cookie, Origin: base });
async function call(
  url: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = session(),
) {
  const isForm = body instanceof FormData;
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined || isForm ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
  });
  const type = response.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, headers: response.headers };
}
async function studio(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const r = await call(`${base}/api${path}`, method, body);
  assert.ok(r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const frontmatter = (fm: Record<string, unknown>, body: string) =>
  `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')}\n---\n\n${body}\n`;
async function waitFor(id: string) {
  for (let i = 0; i < 120; i++) {
    const r = await call(`${harness}/executions/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(r.data.execution.status)) return r.data.execution;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Execution did not finish');
}
function bundleForm(buffer: Buffer, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('bundle', new Blob([buffer], { type: 'application/zip' }), 'agent.zip');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}
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
  provider = await studio('/providers', {
    name: `Agents model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: `agents-chat-${suffix}`,
  });
  connection = await studio('/connections', {
    name: `Agent tools ${suffix}`,
    url: 'http://fixtures:9090/mcp',
  });
  await studio(`/connections/${connection.id}/discover`, {});
});

test('the manifest reports the agent lifecycle operations', async () => {
  const caps = (await call(`${harness}/capabilities`)).data.capabilities;
  assert.equal(caps.agents.supported, true);
  assert.deepEqual([...caps.agents.operations].sort(), [
    'clone',
    'create',
    'delete',
    'export',
    'import',
    'update',
  ]);
});

let created: any;
test('an agent is created from an AGENTS.md bundle, with its skill, MCP server and model resolved', async () => {
  const agentsMd = frontmatter(
    {
      name: `Research agent ${suffix}`,
      vendorKey: 'acme',
      agentKey: `researcher-${suffix}`,
      version: '2.1.0',
      description: 'Looks things up',
      license: 'MIT',
      tags: ['research'],
      model: `agents-chat-${suffix}`,
      skills: [{ name: `cite-${suffix}`, source: 'local', version: '1.0.0', required: true }],
      mcpServers: [
        { vendor: 'acme', server: `Agent tools ${suffix}`, version: '1.0.0', configDir: 'mcp-configs/tools' },
      ],
      config: { tools: { allowed: ['lookup'] }, temperature: 0.2 },
      packs: [{ vendor: 'x', pack: 'y' }],
    },
    '# Purpose\n\nResearch with the lookup tool.',
  );
  const skillMd = `---\nname: cite-${suffix}\ndescription: Use when citing sources.\n---\n\nAlways cite the lookup result.\n`;
  const r = await call(`${harness}/agents`, 'POST', {
    metadata: { name: `Research agent ${suffix}`, description: 'Looks things up' },
    files: [
      { path: 'AGENTS.md', content: agentsMd },
      { path: `skills/cite-${suffix}/SKILL.md`, content: skillMd },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  created = r.data.agent;
  assert.equal(created.slug, `acme/researcher-${suffix}`);
  assert.equal(created.version, '2.1.0');
  assert.equal(created.license, 'MIT');
  assert.deepEqual(created.tags, ['research']);
  assert.equal(created.config.system_prompt, '# Purpose\n\nResearch with the lookup tool.');
  assert.deepEqual(created.config.model, { provider: 'openai-compatible', name: `agents-chat-${suffix}` });
  assert.deepEqual(created.mcp_servers, [{ server_id: connection.id, tools: ['lookup'], required: true }]);
  assert.equal(created.skills.length, 1);
  const skill = (await studio('/skills')).find((s: any) => s.id === created.skills[0].skill_id);
  assert.equal(skill.instructions, 'Always cite the lookup result.');
  assert.ok(r.data.warnings.some((w: string) => /packs/.test(w)));
  assert.ok(r.data.warnings.some((w: string) => /temperature/.test(w)));
  // The agent is a workflow that executes with its tool.
  const accepted = await call(`${harness}/execute`, 'POST', {
    message: 'Please use tool now',
    agent_id: created.id,
  });
  const done = await waitFor(accepted.data.execution_id);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  const result = (await call(`${harness}/executions/${done.id}/result`)).data.result;
  assert.match(result.output, /MCP lookup/);
  // Names are unique on the harness.
  const again = await call(`${harness}/agents`, 'POST', { metadata: { name: `Research agent ${suffix}` } });
  assert.equal(again.status, 409);
});

test('multipart create accepts AGENTS.md files and falls back to the default model with a warning', async () => {
  const form = new FormData();
  form.append('metadata', JSON.stringify({ name: `Multipart agent ${suffix}`, description: 'From a form' }));
  form.append(
    'files',
    new Blob([frontmatter({ model: 'no-such-model-anywhere' }, 'Answer briefly.')], {
      type: 'text/markdown',
    }),
    'AGENTS.md',
  );
  const r = await call(`${harness}/agents`, 'POST', form);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.agent.config.system_prompt, 'Answer briefly.');
  assert.ok(r.data.warnings.some((w: string) => /no-such-model-anywhere/.test(w)));
});

test('agents are listed, read, updated and cloned', async () => {
  const list = await call(`${harness}/agents?limit=100`);
  assert.ok(list.data.data.some((a: any) => a.id === created.id));
  assert.equal(list.data.limit, 100);
  assert.equal((await call(`${harness}/agents/${created.id}`)).data.agent.agentKey, `researcher-${suffix}`);
  assert.equal((await call(`${harness}/agents/${randomUUID()}`)).status, 404);

  const updated = await call(`${harness}/agents/${created.id}`, 'PATCH', {
    description: 'Updated description',
    config: { system_prompt: 'New instructions.', tools_access: { deny: ['lookup'] } },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.agent.description, 'Updated description');
  assert.equal(updated.data.agent.config.system_prompt, 'New instructions.');
  assert.deepEqual(updated.data.agent.mcp_servers, []);
  assert.equal(updated.data.agent['x-openharness'].revision, 2);
  const badModel = await call(`${harness}/agents/${created.id}`, 'PATCH', {
    config: { model: 'nope-model' },
  });
  assert.equal(badModel.status, 400);
  assert.equal(badModel.data.error.code, 'model_not_available');

  const clone = await call(`${harness}/agents/${created.id}/clone`, 'POST', {
    new_name: `Research copy ${suffix}`,
  });
  assert.equal(clone.status, 201, JSON.stringify(clone.data));
  assert.notEqual(clone.data.agent.id, created.id);
  assert.equal(clone.data.agent.agentKey, `research-copy-${suffix}`);
  assert.equal(clone.data.agent.config.system_prompt, 'New instructions.');
});

let exported: Buffer;
test('export produces an OAF package with skills and MCP configs but no secrets', async () => {
  // Restore the tool so the export carries an MCP reference.
  await call(`${harness}/agents/${created.id}`, 'PATCH', {
    config: { system_prompt: 'Research with the lookup tool.' },
  });
  const workflow = await studio(`/workflows/${created.id}`);
  workflow.resources = [
    { id: 'mcp1', name: connection.name, type: 'mcp', connectionId: connection.id, tools: ['lookup'] },
  ];
  workflow.bindings = [{ agentNodeId: 'agent', resourceId: 'mcp1' }];
  await studio(`/workflows/${created.id}`, workflow, 'PUT');

  const r = await call(`${harness}/agents/${created.id}/export`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition')!, new RegExp(`researcher-${suffix}\\.zip`));
  exported = r.data as Buffer;
  const zip = await JSZip.loadAsync(exported);
  const agentsMd = await zip.file('AGENTS.md')!.async('string');
  const fm = parse(agentsMd.split('---')[1]);
  assert.equal(fm.slug, `acme/researcher-${suffix}`);
  assert.equal(fm.harnessConfig.openharness.format, 'openharness-workflow/1');
  assert.ok(fm.harnessConfig.openharness.references.connections[connection.id]);
  assert.ok(zip.file(`skills/cite-${suffix}/SKILL.md`));
  const mcpConfig = await zip.file(`mcp-configs/${`agent-tools-${suffix}`}/config.yaml`)!.async('string');
  assert.match(mcpConfig, /fixtures:9090\/mcp/);
  assert.ok(zip.file('PACKAGE.yaml'));
  assert.doesNotMatch(agentsMd, /apiKey|Encrypted|token/i);
});

test('import honours merge strategies and renames, reusing existing skills and connections', async () => {
  const fail = await call(`${harness}/agents/import`, 'POST', bundleForm(exported));
  assert.equal(fail.status, 409, JSON.stringify(fail.data));
  assert.equal(fail.data.error.details.agent_id, created.id);
  const skip = await call(
    `${harness}/agents/import`,
    'POST',
    bundleForm(exported, { merge_strategy: 'skip' }),
  );
  assert.equal(skip.status, 200);
  assert.equal(skip.data.agent.id, created.id);
  const renamed = await call(
    `${harness}/agents/import`,
    'POST',
    bundleForm(exported, { rename_to: `Imported ${suffix}` }),
  );
  assert.equal(renamed.status, 201, JSON.stringify(renamed.data));
  assert.notEqual(renamed.data.agent.id, created.id);
  assert.equal(renamed.data.agent.agentKey, `imported-${suffix}`);
  assert.deepEqual(renamed.data.agent.mcp_servers, [
    { server_id: connection.id, tools: ['lookup'], required: true },
  ]);
  assert.deepEqual(renamed.data.warnings, []);
  const skills = (await studio('/skills')).filter((s: any) => s.name === `cite-${suffix}`);
  assert.equal(skills.length, 1, 'the existing skill is reused, not duplicated');
  const overwrite = await call(
    `${harness}/agents/import`,
    'POST',
    bundleForm(exported, { merge_strategy: 'overwrite' }),
  );
  assert.equal(overwrite.status, 200, JSON.stringify(overwrite.data));
  assert.equal(overwrite.data.agent.id, created.id);
});

test('imports prune references this workspace lacks and refuse unsafe bundles', async () => {
  const zip = await JSZip.loadAsync(exported);
  const text = await zip.file('AGENTS.md')!.async('string');
  zip.file('AGENTS.md', text.replaceAll(`Agent tools ${suffix}`, `Missing server ${suffix}`));
  const edited = await zip.generateAsync({ type: 'nodebuffer' });
  const r = await call(
    `${harness}/agents/import`,
    'POST',
    bundleForm(edited, { rename_to: `Pruned ${suffix}` }),
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.agent.mcp_servers, []);
  assert.ok(r.data.warnings.some((w: string) => w.includes(`Missing server ${suffix}`)));
  const notZip = await call(`${harness}/agents/import`, 'POST', bundleForm(Buffer.from('plain text')));
  assert.equal(notZip.data.error.code, 'INVALID_BUNDLE');
  const json = await call(`${harness}/agents/import`, 'POST', {});
  assert.equal(json.status, 415);
});

test('agents with running executions cannot be deleted; others can', async () => {
  const accepted = await call(`${harness}/execute`, 'POST', {
    message: 'wait: delay-model',
    agent_id: created.id,
  });
  const blocked = await call(`${harness}/agents/${created.id}`, 'DELETE');
  assert.equal(blocked.status, 409);
  await call(`${harness}/executions/${accepted.data.execution_id}/cancel`, 'POST');
  await waitFor(accepted.data.execution_id);
  const removed = await call(`${harness}/agents/${created.id}`, 'DELETE');
  assert.equal(removed.status, 204);
  assert.equal((await call(`${harness}/agents/${created.id}`)).status, 404);
});

test('tools list MCP and built-in tools, and invoke them directly with validation', async () => {
  const list = await call(`${harness}/tools?limit=100`);
  const ids = list.data.data.map((t: any) => t.id);
  assert.ok(ids.includes('builtin.load_skill'));
  const lookup = list.data.data.find((t: any) => t.id === `mcp.${connection.id}.lookup`);
  assert.equal(lookup.source, 'mcp');
  assert.equal(lookup.source_id, connection.id);
  assert.equal(lookup.input_schema.type, 'object');
  assert.equal(lookup['x-openharness'].server, connection.name);
  const builtins = await call(`${harness}/tools?source=builtin`);
  assert.deepEqual(
    builtins.data.data.map((t: any) => t.id),
    ['builtin.load_skill'],
  );
  assert.equal((await call(`${harness}/tools/${lookup.id}`)).data.tool.name, 'lookup');
  assert.equal((await call(`${harness}/tools/mcp.${randomUUID()}.lookup`)).status, 404);

  const ok = await call(`${harness}/tools/${lookup.id}/invoke`, 'POST', { input: { query: 'direct' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.success, true);
  assert.deepEqual(ok.data.output.structured, { answer: 'MCP lookup: direct' });
  assert.ok(ok.data.duration_ms >= 0);
  const invalid = await call(`${harness}/tools/${lookup.id}/invoke`, 'POST', { input: { query: 42 } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, 'VALIDATION_ERROR');
  const failing = await call(`${harness}/tools/mcp.${connection.id}.fail/invoke`, 'POST', { input: {} });
  assert.equal(failing.data.success, false);
  assert.match(failing.data.error, /Intentional fixture failure/);
  const skill = await call(`${harness}/tools/builtin.load_skill/invoke`, 'POST', {
    input: { name: `cite-${suffix}` },
  });
  assert.equal(skill.data.output.content, 'Always cite the lookup result.');

  const stream = await fetch(`${harness}/tools/mcp.${connection.id}.calculate/invoke/stream`, {
    method: 'POST',
    headers: { ...session(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { a: 2, b: 3 } }),
  });
  const events = (await stream.text())
    .split('\n\n')
    .filter(Boolean)
    .map((b) =>
      JSON.parse(
        b
          .split('\n')
          .find((l) => l.startsWith('data: '))!
          .slice(6),
      ),
    );
  assert.deepEqual(
    events.map((e) => e.type),
    ['output', 'done'],
  );
  assert.deepEqual(events[0].data.structured, { sum: 5 });
  assert.equal(events[1].success, true);

  const register = await call(`${harness}/tools`, 'POST', {
    name: 'x',
    description: 'x',
    input_schema: {},
    handler: { type: 'webhook', url: 'https://example.com' },
  });
  assert.equal(register.status, 501);
  assert.equal((await call(`${harness}/tools/${lookup.id}`, 'DELETE')).status, 409);
});

test('workflow keys read their own agent but cannot manage agents or invoke tools', async () => {
  const flow = (await call(`${harness}/agents?limit=100`)).data.data.find(
    (a: any) => a.name === `Multipart agent ${suffix}`,
  );
  const key = await studio('/integrations/tokens', { name: `Agents key ${suffix}`, workflowIds: [flow.id] });
  const auth = { Authorization: `Bearer ${key.token}` };
  const list = await call(`${harness}/agents`, 'GET', undefined, auth);
  assert.deepEqual(
    list.data.data.map((a: any) => a.id),
    [flow.id],
  );
  assert.equal((await call(`${harness}/agents`, 'POST', { metadata: { name: 'x' } }, auth)).status, 403);
  assert.equal((await call(`${harness}/agents/${flow.id}`, 'DELETE', undefined, auth)).status, 403);
  const invoke = await call(
    `${harness}/tools/builtin.load_skill/invoke`,
    'POST',
    { input: { name: 'x' } },
    auth,
  );
  assert.equal(invoke.data.error.code, 'INSUFFICIENT_SCOPE');
});

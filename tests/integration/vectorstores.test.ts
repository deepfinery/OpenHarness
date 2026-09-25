import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// Pluggable vector stores (#18): the same knowledge flow runs on every driver, end to end. The OpenAI-compatible
// store is served by the fixture's in-memory Vector Stores API and embeds text itself.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const project = process.env.TEST_COMPOSE_PROJECT ?? 'openharness-test';
const suffix = randomUUID().slice(0, 8);
const fixture = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
const stores = ['weaviate', 'qdrant', 'opensearch', 'elasticsearch', 'openai'] as const;
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
let cookie = '';
let provider: any;

async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined };
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await request(path, body, method);
  assert.ok(
    r.status < 300,
    `${method ?? (body ? 'POST' : 'GET')} ${path}: ${r.status} ${JSON.stringify(r.data)}`,
  );
  return r.data;
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string) {
  for (let i = 0; i < 80; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
/** Runs a small script inside the api container, where the stores are reachable. */
async function insideStack(script: string) {
  if (!project.startsWith('openharness-test')) throw new Error('Only isolated test projects are inspected');
  const { stdout } = await promisify(execFile)(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      'compose.yaml',
      '-f',
      'tests/compose.test.yaml',
      'exec',
      '-T',
      'api',
      'node',
      '-e',
      script,
    ],
    { timeout: 30000 },
  );
  return stdout.trim();
}
/** Whether the store still holds the knowledge base's index. */
async function indexExists(store: (typeof stores)[number], kbId: string) {
  const name = `Knowledge_${kbId.replace(/-/g, '')}`;
  switch (store) {
    case 'qdrant':
      return JSON.parse(
        await insideStack(
          "fetch('http://qdrant:6333/collections',{headers:{'api-key':process.env.QDRANT_API_KEY||''}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.result.collections.map(c=>c.name))))",
        ),
      ).includes(name);
    case 'opensearch':
    case 'elasticsearch':
      return (
        (await insideStack(
          `fetch('http://${store}:9200/${name.toLowerCase()}').then(r=>console.log(r.status))`,
        )) === '200'
      );
    case 'openai': {
      const r = await fetch(`${fixture}/openai/v1/vector_stores`, {
        headers: { Authorization: 'Bearer test-vector-stores-key' },
      });
      return ((await r.json()) as any).data.some((v: any) => v.name === name);
    }
    default:
      return (
        (await insideStack(
          `fetch('http://weaviate:8080/v1/schema/${name}',{headers:{Authorization:'Bearer '+process.env.WEAVIATE_API_KEY}}).then(r=>console.log(r.status))`,
        )) === '200'
      );
  }
}
before(async () => {
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
    name: `Vector model ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
});

test('the deployment reports every configured store, with Weaviate as the default', async () => {
  const cfg = await ok('/config');
  assert.deepEqual(cfg.vectorStores, { available: [...stores], default: 'weaviate' });
  const health = await (await fetch(`${base}/openharness/v1/harnesses/openharness/health`)).json();
  for (const store of stores.filter((s) => s !== 'weaviate')) {
    const check = health.checks.find((c: any) => c.name === `vector_store:${store}`);
    assert.equal(check?.status, 'pass', `${store}: ${JSON.stringify(check)}`);
  }
});

for (const store of stores)
  test(`knowledge on ${store}: index, search within the tenant's base, delete a document and the base`, async () => {
    const kb = await ok('/knowledge', {
      name: `${store} handbook ${suffix}`,
      providerId: provider.id,
      vectorStore: store,
    });
    assert.equal(kb.vectorStore, store);
    const other = await ok('/knowledge', {
      name: `${store} other ${suffix}`,
      providerId: provider.id,
      vectorStore: store,
    });
    const note = await ok(`/knowledge/${kb.id}/notes`, {
      title: `Release process ${store}`,
      content: `The ${store} release process has four stages and every stage has an owner.`,
    });
    await ok(`/knowledge/${other.id}/notes`, {
      title: 'Unrelated',
      content: 'Lunch is served at noon on Fridays.',
    });
    await until(
      () => ok(`/knowledge/${kb.id}/documents`),
      (docs: any[]) => docs.every((d) => d.status === 'ready'),
      `${store} indexing`,
    );
    const hits = await ok(`/knowledge/${kb.id}/search`, { query: 'release stages owner' });
    assert.ok(hits.length >= 1, JSON.stringify(hits));
    assert.ok(
      hits.every((h: any) => h.documentId === note.id),
      'search stays inside its own knowledge base',
    );
    assert.match(hits[0].content, new RegExp(`${store} release process`));

    // An agent retrieves from the base through the same store.
    const flow = await ok('/workflows', {
      name: `${store} grounded ${suffix}`,
      startAt: 'start',
      nodes: [
        { id: 'start', name: 'Start', type: 'start', next: 'agent' },
        {
          id: 'agent',
          name: 'Agent',
          type: 'agent',
          prompt: '{{input}}',
          next: 'finish',
          config: { name: 'Agent', providerId: provider.id, systemPrompt: 'Answer from knowledge.' },
        },
        { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
      ],
      resources: [{ id: 'kb', name: 'Handbook', type: 'knowledge', knowledgeBaseId: kb.id }],
      bindings: [{ agentNodeId: 'agent', resourceId: 'kb' }],
    });
    const run = await ok('/runs', { workflowId: flow.id, input: 'How many release stages are there?' });
    const finished = await until(
      () => ok(`/runs/${run.id}`),
      (r: any) => !['queued', 'running'].includes(r.status),
      'the run',
    );
    assert.equal(finished.status, 'succeeded', finished.error);
    assert.match(finished.output, new RegExp(`${store} release process has four stages`));

    const moved = await request(
      `/knowledge/${kb.id}`,
      { ...kb, vectorStore: store === 'weaviate' ? 'qdrant' : 'weaviate' },
      'PUT',
    );
    assert.equal(moved.status, 409, 'a base with documents keeps its store');

    await ok(`/documents/${note.id}`, undefined, 'DELETE');
    await until(
      () => ok(`/knowledge/${kb.id}/documents`),
      (docs: any[]) => docs.length === 0,
      'document removal',
    );
    assert.deepEqual(await ok(`/knowledge/${kb.id}/search`, { query: 'release stages owner' }), []);

    await ok(`/workflows/${flow.id}`, undefined, 'DELETE');
    assert.ok(await indexExists(store, kb.id), `${store} holds the index`);
    await ok(`/knowledge/${kb.id}`, undefined, 'DELETE');
    assert.ok(!(await indexExists(store, kb.id)), `deleting the base drops its ${store} index`);
  });

test('an unknown store is rejected, and edits that omit the store keep it', async () => {
  const bad = await request('/knowledge', {
    name: `Bad ${suffix}`,
    providerId: provider.id,
    vectorStore: 'pinecone',
  });
  assert.equal(bad.status, 400);
  const plain = await ok('/knowledge', { name: `Default ${suffix}`, providerId: provider.id });
  assert.equal(plain.vectorStore, 'weaviate');
  const kept = await ok(
    `/knowledge/${plain.id}`,
    { name: plain.name, description: 'edited', providerId: provider.id },
    'PUT',
  );
  assert.equal(kept.vectorStore, 'weaviate');
});

test('a store that embeds text itself needs no embedding model', async () => {
  const chatOnly = await ok('/providers', {
    name: `Chat only ${suffix}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  const refused = await request('/knowledge', {
    name: `Needs embeddings ${suffix}`,
    providerId: chatOnly.id,
    vectorStore: 'qdrant',
  });
  assert.equal(refused.status, 400);
  const managed = await ok('/knowledge', {
    name: `Managed ${suffix}`,
    providerId: chatOnly.id,
    vectorStore: 'openai',
  });
  await ok(`/knowledge/${managed.id}/notes`, {
    title: 'Hours',
    content: 'The support desk is open from nine to five on weekdays.',
  });
  await until(
    () => ok(`/knowledge/${managed.id}/documents`),
    (docs: any[]) => docs.length > 0 && docs.every((d) => d.status === 'ready'),
    'managed indexing',
  );
  const hits = await ok(`/knowledge/${managed.id}/search`, { query: 'when is the support desk open' });
  assert.match(hits[0].content, /nine to five/);
});

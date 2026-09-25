import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// Pluggable vector stores (#18): the same knowledge flow runs on Weaviate and on Qdrant, end to end.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const project = process.env.TEST_COMPOSE_PROJECT ?? 'openharness-test';
const suffix = randomUUID().slice(0, 8);
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
/** Lists Qdrant collections from inside the stack (the store has no host port). */
async function qdrantCollections(): Promise<string[]> {
  if (!project.startsWith('openharness-test')) throw new Error('Only isolated test projects are inspected');
  const script =
    "fetch('http://qdrant:6333/collections',{headers:{'api-key':process.env.QDRANT_API_KEY||''}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j.result.collections.map(c=>c.name))))";
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
  return JSON.parse(stdout.trim());
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

test('the deployment reports both stores, with Weaviate as the default', async () => {
  const cfg = await ok('/config');
  assert.deepEqual(cfg.vectorStores, { available: ['weaviate', 'qdrant'], default: 'weaviate' });
  const health = await (await fetch(`${base}/openharness/v1/harnesses/openharness/health`)).json();
  const qdrant = health.checks.find((c: any) => c.name === 'vector_store:qdrant');
  assert.equal(qdrant?.status, 'pass');
});

for (const store of ['weaviate', 'qdrant'] as const)
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
      { ...kb, vectorStore: store === 'qdrant' ? 'weaviate' : 'qdrant' },
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
    if (store === 'qdrant') {
      const collection = `Knowledge_${kb.id.replace(/-/g, '')}`;
      assert.ok((await qdrantCollections()).includes(collection));
      await ok(`/knowledge/${kb.id}`, undefined, 'DELETE');
      assert.ok(!(await qdrantCollections()).includes(collection), 'deleting the base drops its index');
    } else await ok(`/knowledge/${kb.id}`, undefined, 'DELETE');
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

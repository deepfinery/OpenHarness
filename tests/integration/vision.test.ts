import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
let cookie = '',
  ownerId = '',
  llm = '',
  vision = '',
  embedding = '',
  image = '',
  agent = '';
const png = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ff0000' } })
  .png()
  .toBuffer();
async function req(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return fetch(base + '/api' + path, {
    method,
    headers: {
      Origin: base,
      Cookie: cookie,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
}
async function ok(path: string, body?: unknown, method?: string) {
  const r = await req(path, body, method);
  const j = r.status === 204 ? null : await r.json();
  assert.ok(r.ok, `${path}: ${JSON.stringify(j)}`);
  return j;
}
async function login(credentials: object) {
  const r = await req('/auth/login', credentials);
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie')!.split(';')[0];
}
const model = (modelType: string, model: string) =>
  ok('/providers', {
    name: model,
    modelType,
    model,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    contextWindow: 128000,
  });
async function upload(bytes = png) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'table.png');
  return req('/images', form);
}
async function finished(id: string) {
  for (let i = 0; i < 120; i++) {
    const r = await ok('/runs/' + id);
    if (!['queued', 'running'].includes(r.status)) {
      assert.equal(r.status, 'succeeded', r.error);
      return r;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Run timed out');
}
before(async () => {
  const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
  if ((await ok('/auth/status')).needsSetup)
    await ok('/auth/setup', {
      ...admin,
      name: 'Test administrator',
      setupToken: (await readFile('.env', 'utf8'))
        .split('\n')
        .find((l) => l.startsWith('SETUP_TOKEN='))!
        .slice(12),
    });
  await login(admin);
  const user = { email: `vision-${randomUUID()}@openharness.test`, password: admin.password };
  await ok('/users', { ...user, name: 'Vision test', workspace: 'new' });
  await login(user);
  ownerId = (await ok('/auth/me')).tenantId;
  llm = (await model('llm', 'test-identity')).id;
  vision = (await model('vision', 'test-vision')).id;
  embedding = (await model('embedding', 'test-embedding')).id;
  agent = (
    await ok('/agents', {
      name: 'Image reader',
      systemPrompt: 'Read the attached images.',
      providerId: llm,
      visionProviderId: vision,
      tokenBudget: 100000,
    })
  ).id;
});

test('uploads decode real pixels, reject disguised files, and isolate tenants', async () => {
  const uploaded = await upload();
  assert.equal(uploaded.status, 201);
  image = (await uploaded.json()).id;
  const r = await req('/images/' + image);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  const info = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
  assert.equal(info.width, 80);
  assert.equal((await upload(Buffer.from('<svg onload="bad"/>'))).status, 400);
  assert.equal((await req('/images/' + randomUUID())).status, 404);
  const ourCookie = cookie;
  await login({ email: 'admin@openharness.test', password: 'Integration-test-password-42' });
  assert.equal((await req('/images/' + image)).status, 404);
  const outsider = await ok('/agents', {
    name: 'Outsider',
    systemPrompt: 'Read',
    providerId: (await model('vision', 'test-vision')).id,
  });
  assert.equal(
    (await req('/runs', { agentId: outsider.id, input: 'Read image', attachments: [image] })).status,
    404,
  );
  cookie = ourCookie;
});

test('typed models enforce chat, embedding and vision selection boundaries', async () => {
  assert.equal(
    (await req('/agents', { name: 'Bad', systemPrompt: 'Read', providerId: embedding })).status,
    400,
  );
  assert.equal(
    (await req('/agents', { name: 'Bad', systemPrompt: 'Read', providerId: llm, visionProviderId: llm }))
      .status,
    400,
  );
  assert.equal((await req('/knowledge', { name: 'Bad', providerId: llm })).status, 400);
  const kb = await ok('/knowledge', { name: 'Embedding notebook', providerId: embedding });
  assert.equal(kb.providerId, embedding);
  const tested = await ok('/providers/test-config', {
    name: 'Embedding only',
    modelType: 'embedding',
    model: 'test-embedding',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
  });
  assert.equal(tested.embedding.ok, true);
  const visionTest = await ok('/providers/' + vision + '/test', {});
  assert.equal(JSON.parse(visionTest.text).images, 1, 'vision connectivity sends actual pixels');
  assert.equal(
    (
      await req('/providers', {
        name: 'Combined',
        modelType: 'llm',
        model: 'test-chat',
        embeddingModel: 'test-embedding',
        kind: 'openai-compatible',
        baseUrl: 'http://fixtures:9090/v1',
      })
    ).status,
    400,
  );
  assert.equal((await req('/providers/' + vision, undefined, 'DELETE')).status, 409);
  const removable = await ok('/agents', {
    name: 'Remove vision selection',
    systemPrompt: 'Read',
    providerId: llm,
    visionProviderId: vision,
  });
  await ok('/agents/' + removable.id, { ...removable, visionProviderId: undefined }, 'PUT');
  assert.equal((await ok('/agents/' + removable.id)).visionProviderId, undefined);
  assert.equal(
    (await req('/runs', { agentId: removable.id, input: 'Read', attachments: [image] })).status,
    400,
  );
  const textOnly = await ok('/agents', { name: 'Text only', systemPrompt: 'Read', providerId: llm });
  assert.equal(
    (await req('/runs', { agentId: textOnly.id, input: 'Read', attachments: [image] })).status,
    400,
  );
});

test('image chat uses vision, persists references, and sees images again on follow-up', async () => {
  const turn = await ok('/chat', { agentId: agent, message: 'Hi', attachments: [image] });
  const r = await finished(turn.id);
  assert.deepEqual(JSON.parse(r.output), { images: 1, valid: true, model: 'test-vision' });
  assert.equal(r.events.find((e: any) => e.type === 'model_request').data.providerId, vision);
  const c = await ok('/conversations/' + turn.conversationId);
  assert.deepEqual(c.messages[0].attachments, [image]);
  assert.ok(!JSON.stringify(r).includes('data:image'));
  const second = await ok('/chat', { conversationId: turn.conversationId, message: 'Read it again' });
  assert.equal(JSON.parse((await finished(second.id)).output).images, 1);
  const text = await ok('/chat', { agentId: agent, message: 'What model are you?' });
  assert.equal(
    (await finished(text.id)).events.find((e: any) => e.type === 'model_request').data.providerId,
    llm,
  );
});

test('delegated image work inherits the vision route and durable image references', async () => {
  const p = await ok('/providers/' + vision);
  await ok('/providers/' + vision, { ...p, streaming: false }, 'PUT');
  const a = await ok('/agents/' + agent);
  await ok('/agents/' + agent, { ...a, delegation: { enabled: true }, tokenBudget: 100000 }, 'PUT');
  for (const past of [false, true]) {
    const accepted = await ok('/runs', {
      agentId: agent,
      input: 'Please delegate image analysis',
      ...(past
        ? { history: [{ role: 'user', content: 'Read this', attachments: [image] }] }
        : { attachments: [image] }),
    });
    const r = await finished(accepted.id);
    const childId = r.events.find((e: any) => e.type === 'subagent_started')?.data.subagentId;
    assert.ok(childId, JSON.stringify(r.events));
    const child = await ok('/runs/' + childId);
    assert.equal(child.status, 'succeeded', child.error);
    assert.equal(JSON.parse(child.output).images, 1);
    assert.equal(child.events.find((e: any) => e.type === 'model_request').data.providerId, vision);
    assert.deepEqual(past ? child.history[0].attachments : child.attachments, [image]);
  }
});

test(
  'legacy combined providers migrate idempotently with credentials and notebook references intact',
  { skip: !process.env.TEST_COMPOSE_PROJECT },
  async () => {
    await login({ email: 'admin@openharness.test', password: 'Integration-test-password-42' });
    const user = {
      email: `migration-${randomUUID()}@openharness.test`,
      password: 'Integration-test-password-42',
    };
    await ok('/users', { ...user, name: 'Migration test', workspace: 'new' });
    await login(user);
    ownerId = (await ok('/auth/me')).tenantId;
    const legacy = await ok('/providers', {
      name: 'Legacy combined',
      model: 'test-chat',
      embeddingModel: 'test-embedding',
      apiKey: 'fixture-migration-secret',
      kind: 'openai-compatible',
      baseUrl: 'http://fixtures:9090/v1',
    });
    const kb = await ok('/knowledge', { name: 'Legacy notebook', providerId: legacy.id });
    const code = `import assert from 'node:assert/strict'; import {archiveMemory,searchArchive} from './dist/packages/core/src/agentMemory.js'; import {mongo} from './dist/packages/core/src/db.js'; import {migrateModelRoles} from './dist/packages/core/src/modelRoles.js'; await mongo.connect(); const owner=${JSON.stringify(ownerId)}; await archiveMemory(owner,'migration-agent','The verification code is cobalt.'); assert.equal((await searchArchive(owner,'migration-agent','verification code',5)).length,1); await migrateModelRoles(owner); await migrateModelRoles(owner); assert.equal((await searchArchive(owner,'migration-agent','verification code',5))[0].content,'The verification code is cobalt.'); await mongo.close();`;
    execFileSync('docker', [
      'compose',
      '-p',
      process.env.TEST_COMPOSE_PROJECT!,
      '-f',
      'compose.yaml',
      '-f',
      'tests/compose.test.yaml',
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      code,
    ]);
    const original = await ok('/providers/' + legacy.id);
    assert.equal(original.modelType, 'llm');
    assert.equal(original.hasApiKey, true);
    assert.equal(original.embeddingModel, '');
    const updated = await ok('/knowledge/' + kb.id);
    assert.notEqual(updated.providerId, legacy.id);
    const copy = await ok('/providers/' + updated.providerId);
    assert.equal(copy.modelType, 'embedding');
    assert.equal(copy.legacyEmbeddingSourceId, legacy.id);
    assert.equal(copy.model, 'test-embedding');
    assert.equal(copy.hasApiKey, true);
    const list = await ok('/providers');
    assert.equal(list.filter((p: any) => p.name === 'Legacy combined · Embedding').length, 1);
    assert.ok(!JSON.stringify(list).includes('fixture-migration-secret'));
  },
);

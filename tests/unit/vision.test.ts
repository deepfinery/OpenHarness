import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
const dir = await mkdtemp(join(tmpdir(), 'openharness-vision-'));
process.env.DATA_DIR = dir;
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'vision-unit-tests'.repeat(3);
process.env.ALLOWED_PRIVATE_HOSTS = 'vision.test';
const { db } = await import('../../packages/core/src/db.js');
const { imageAttachments, saveImage } = await import('../../packages/core/src/images.js');
const { chat } = await import('../../packages/core/src/llm.js');
const { providerSchema } = await import('../../packages/core/src/schema.js');
const { compactDialog } = await import('../../packages/core/src/context.js');
const { finalAnswerMessages } = await import('../../packages/core/src/finalAnswer.js');
const { saveFile } = await import('../../packages/core/src/storage.js');
const ownerId = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ff0000' } })
  .jpeg()
  .toBuffer();
await saveFile(`${ownerId}/${id}`, bytes);
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

for (const kind of ['openai-compatible', 'anthropic', 'gemini', 'ollama'] as const) {
  test(`${kind} sends actual image bytes in its native wire format`, async (t) => {
    const records = imageAttachments();
    t.mock.method(db, 'collection', () => records as any);
    t.mock.method(imageAttachments(), 'findOne', async (query: any) => {
      assert.deepEqual(query, { _id: id, ownerId });
      return { _id: id, ownerId, mimeType: 'image/jpeg', storageKey: `${ownerId}/${id}` };
    });
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const b = JSON.parse(String(init?.body));
      if (kind !== 'gemini') assert.equal(b.model, 'vision-model');
      if (kind === 'openai-compatible')
        assert.equal(
          b.messages[0].content[1].image_url.url,
          `data:image/jpeg;base64,${bytes.toString('base64')}`,
        );
      if (kind === 'anthropic') assert.equal(b.messages[0].content[1].source.data, bytes.toString('base64'));
      if (kind === 'gemini') assert.equal(b.contents[0].parts[1].inlineData.data, bytes.toString('base64'));
      if (kind === 'ollama') assert.deepEqual(b.messages[0].images, [bytes.toString('base64')]);
      return Response.json({
        choices: [{ message: { content: 'red' } }],
        message: { content: 'red' },
        content: [{ type: 'text', text: 'red' }],
        candidates: [{ content: { parts: [{ text: 'red' }] }, finishReason: 'STOP' }],
      });
    });
    const p = {
      ...providerSchema.parse({
        name: 'Vision',
        kind,
        baseUrl: 'http://vision.test/v1',
        model: 'vision-model',
        modelType: 'vision',
      }),
      _id: id,
      ownerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await chat(p, [{ role: 'user', content: 'Color?', images: [id] }], []);
    assert.equal(result.text, 'red');
    await assert.rejects(
      chat({ ...p, modelType: 'llm' }, [{ role: 'user', content: 'Color?', images: [id] }], []),
      /vision model/,
    );
    await assert.rejects(
      chat({ ...p, modelType: 'embedding' }, [{ role: 'user', content: 'Hi' }], []),
      /cannot generate chat/,
    );
  });
}

test('current images survive compaction and final synthesis; oversized protected context fails closed', () => {
  const image = {
    role: 'user' as const,
    content: 'Attached image',
    images: [id],
    currentImages: true,
    reference: true,
  };
  const messages = [
    { role: 'system' as const, content: 'Assist' },
    { role: 'assistant' as const, content: 'old '.repeat(10000) },
    image,
    { role: 'user' as const, content: 'Read the table' },
  ];
  assert.ok(compactDialog(messages, 10000).messages.some((m) => m.images?.includes(id)));
  assert.equal(compactDialog(messages, 1000).fits, false);
  assert.ok(
    finalAnswerMessages('Assist', 'Read the table', messages, []).some((m) => m.images?.includes(id)),
  );
});

test('image upload decodes content, strips metadata and rejects disguised files', async (t) => {
  const records = imageAttachments();
  t.mock.method(db, 'collection', () => records as any);
  t.mock.method(imageAttachments(), 'aggregate', () => ({ next: async () => null }) as any);
  t.mock.method(imageAttachments(), 'insertOne', async () => ({ acknowledged: true }) as any);
  await assert.rejects(saveImage(ownerId, 'fake.png', Buffer.from('<svg onload="alert(1)"/>')), /valid PNG/);
  await assert.rejects(saveImage(ownerId, 'large.jpg', Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MB/);
  const result = await saveImage(ownerId, '../photo.png', bytes);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.ok(!result.filename.includes('/'));
  assert.equal(result.width, 40);
});

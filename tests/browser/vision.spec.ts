import { test, expect } from '@playwright/test';
import sharp from 'sharp';
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const tag = Date.now().toString(36);
let workflowId = '';
let cookies: any[] = [];
const png = await sharp({ create: { width: 120, height: 70, channels: 3, background: '#ff0000' } })
  .png()
  .toBuffer();
test.beforeAll(async ({ request }) => {
  async function api(path: string, data: unknown) {
    const r = await request.post('/api' + path, { headers: { Origin: base }, data });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  await api('/auth/login', { email: 'admin@openharness.test', password: 'Integration-test-password-42' });
  const llm = await api('/providers', {
    name: 'Browser text ' + tag,
    kind: 'openai-compatible',
    modelType: 'llm',
    model: 'test-identity',
    baseUrl: 'http://fixtures:9090/v1',
  });
  const vision = await api('/providers', {
    name: 'Browser vision ' + tag,
    kind: 'openai-compatible',
    modelType: 'vision',
    model: 'test-vision',
    baseUrl: 'http://fixtures:9090/v1',
  });
  workflowId = (
    await api('/workflows', {
      name: 'Vision browser ' + tag,
      startAt: 'start',
      nodes: [
        { id: 'start', name: 'Start', type: 'start', next: 'read' },
        {
          id: 'read',
          name: 'Read image',
          type: 'agent',
          prompt: '{{input}}',
          config: {
            name: 'Reader',
            providerId: llm.id,
            visionProviderId: vision.id,
            systemPrompt: 'Read the image.',
            tokenBudget: 100000,
          },
          next: 'finish',
        },
        { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
      ],
    })
  ).id;
  cookies = (await request.storageState()).cookies;
});
test('Playground file picker, previews, removal, image response and persisted follow-up', async ({
  page,
  context,
}) => {
  await context.addCookies(cookies);
  await page.goto('/');
  await page
    .locator('.sidebar nav')
    .getByRole('button', { name: /^Playground/ })
    .click();
  await page.getByLabel('Playground agent or harness').selectOption('workflow:' + workflowId);
  await expect(page.getByLabel('Message your agent')).toBeEnabled();
  await page
    .getByLabel('Upload images')
    .setInputFiles({ name: 'table.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.pending-images img')).toHaveCount(1);
  await page.getByLabel('Remove table.png').click();
  await expect(page.locator('.pending-images img')).toHaveCount(0);
  // Exercise native file drag/drop independently of the picker.
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
      return dt;
    },
    [...png],
  );
  await page.locator('.playground-main').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('.pending-images img')).toHaveCount(1);
  await page.getByLabel('Message your agent').fill('Read this table');
  await page.getByLabel('Send message', { exact: true }).click();
  await expect(page.locator('.chat-message.assistant').last()).toContainText('test-vision');
  await expect(page.locator('.chat-message.user img')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.chat-message.user img')).toHaveCount(1);
  await page.getByLabel('Message your agent').fill('Read it again');
  await page.getByLabel('Send message', { exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(2);
  await expect(page.locator('.chat-message.assistant').last()).toContainText('"images":1');
  await page.screenshot({ path: '/tmp/openharness-119-playground.png', fullPage: true });
});

test('model editor defines exactly one model and hides generation controls for embeddings', async ({
  page,
  context,
}) => {
  await context.addCookies(cookies);
  await page.goto('/');
  await page
    .locator('.sidebar nav')
    .getByRole('button', { name: /^Settings/ })
    .click();
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  await page.getByLabel('Model type', { exact: true }).selectOption('embedding');
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Maximum output tokens')).toBeHidden();
  await expect(page.getByLabel('Embedding model', { exact: true })).toHaveCount(0);
  await page.getByLabel('Model type', { exact: true }).selectOption('vision');
  await expect(page.getByLabel('Model ID', { exact: true })).toBeVisible();
});

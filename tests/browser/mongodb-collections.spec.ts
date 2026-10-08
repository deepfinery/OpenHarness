import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const password = 'Integration-test-password-42';
function setupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  const line = readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('SETUP_TOKEN='));
  return line?.slice('SETUP_TOKEN='.length).trim() ?? '';
}
async function workspace(page: Page) {
  const api = async (path: string, data?: unknown) => {
    const r = await page.request.fetch('/api' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: base },
      data,
    });
    expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  const admin = { email: 'admin@openharness.test', password };
  if ((await api('/auth/status')).needsSetup)
    await api('/auth/setup', { ...admin, name: 'Test administrator', setupToken: setupToken() });
  else await api('/auth/login', admin);
  const credentials = { email: `mongo-browser-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser MongoDB', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}

test('Knowledge → Collections: connect MongoDB, create, insert, browse, edit, index, delete, then a harness runs the same lifecycle', async ({
  page,
}) => {
  const api = await workspace(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (dialog) => void dialog.accept());

  // The Documents tab is the existing knowledge-base view; Collections starts with connecting MongoDB.
  await page.goto('/knowledge');
  await expect(page.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Collections' }).click();
  await expect(page).toHaveURL(/\/knowledge\/collections$/);
  await page.getByRole('button', { name: 'Connect MongoDB' }).click();
  await expect(page.getByLabel('MCP server type')).toHaveValue('mongodb');
  await expect(page.getByLabel('MongoDB server')).toHaveValue('builtin');
  await expect(page.getByLabel('MCP server URL')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save and discover tools' }).click();
  await expect(page.getByText('Workspace database')).toBeVisible();
  const connection = (await api('/connections')).find((c: any) => c.kind === 'mongodb');
  expect(connection.tools.map((t: any) => t.name)).toContain('insert-many');

  // Create a collection and insert an array of JSON documents.
  await page.getByLabel('New collection name').fill('orders');
  await page.getByRole('button', { name: 'Create collection' }).click();
  const card = page.locator('.kb-card', { hasText: 'orders' });
  await expect(card).toContainText('0 documents');
  await page.getByRole('button', { name: 'Insert JSON' }).first().click();
  await page.getByLabel('JSON documents').fill(
    JSON.stringify([
      { sku: 'A-1', status: 'new', note: 'blue widget' },
      { sku: 'B-2', status: 'new', note: 'red gadget', lines: [{ qty: 2 }] },
    ]),
  );
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(card).toContainText('2 documents');
  await expect(page.locator('.kb-file')).toHaveCount(2);

  // Browse with a filter, open the record and edit it.
  await page.getByLabel('Filter').fill('{ "sku": "B-2" }');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.kb-file')).toHaveCount(1);
  await expect(page.locator('.kb-files-title small')).toContainText('1 document match the filter');
  await page.locator('.kb-file').first().click();
  await expect(page.locator('.kb-preview pre')).toContainText('"red gadget"');
  await page.getByRole('button', { name: 'Edit document' }).click();
  const editor = page.getByLabel('Edit document JSON');
  const record = JSON.parse(await editor.inputValue());
  await editor.fill(JSON.stringify({ ...record, status: 'shipped', note: undefined }, null, 2));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.kb-preview pre')).toContainText('"shipped"');
  await expect(page.locator('.kb-preview pre')).not.toContainText('red gadget');

  // Index a field for retrieval, then search it.
  await page.getByRole('button', { name: 'Indexes' }).click();
  await page.getByLabel('Field to index').fill('note');
  await page.getByLabel('Index type').selectOption('text');
  await page.getByRole('button', { name: 'Add index' }).click();
  await expect(page.locator('.mongo-indexes')).toContainText('note_text');
  await page.getByLabel('Filter').fill('{ "$text": { "$search": "widget" } }');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.kb-file')).toHaveCount(1);
  await expect(page.locator('.kb-file').first()).toContainText('A-1');
  await page.screenshot({ path: 'test-results/mongodb-collections.png', fullPage: true });

  // Delete the record, then the collection.
  await page.locator('.kb-file').first().click();
  await page.getByRole('button', { name: 'Delete document' }).click();
  await expect(card).toContainText('1 document');
  await card.locator('button[title="Delete orders"]').click();
  await expect(page.locator('.kb-card', { hasText: 'orders' })).toHaveCount(0);

  // A harness whose agent manages a collection end to end with the same connection's tools.
  const provider = await api('/providers', {
    name: 'Browser MongoDB model',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-mongo',
  });
  const harness = await api('/workflows', {
    name: 'MongoDB lifecycle harness',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'agent' },
      {
        id: 'agent',
        type: 'agent',
        name: 'Collection keeper',
        prompt: '{{input}}',
        config: {
          name: 'Collection keeper',
          providerId: provider.id,
          systemPrompt: 'Manage records in MongoDB collections.',
          maxTurns: 20,
          connections: [
            {
              connectionId: connection.id,
              tools: [
                'create-collection',
                'insert-many',
                'find',
                'update-many',
                'delete-many',
                'count',
                'drop-collection',
              ],
            },
          ],
        },
        next: 'finish',
      },
      { id: 'finish', type: 'finish', name: 'Finish', template: '{{last}}' },
    ],
  });
  await page.goto('/playground');
  await page.getByLabel('Playground agent or harness').selectOption(`workflow:${harness.id}`);
  const chat = page.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST');
  await page.getByLabel('Message your agent').fill('mongo harness lifecycle');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const runId = (await (await chat).json()).runId as string;
  await expect(page.locator('.chat-message.assistant .markdown').last()).toContainText(
    'Lifecycle complete after 8 MongoDB calls',
    { timeout: 45000 },
  );
  const run = await api(`/runs/${runId}`);
  expect(run.status).toBe('succeeded');
  expect(run.events.filter((e: any) => e.type === 'tool_completed').map((e: any) => e.data.tool)).toEqual([
    'create-collection',
    'insert-many',
    'find',
    'update-many',
    'find',
    'delete-many',
    'count',
    'drop-collection',
  ]);
  await page.screenshot({ path: 'test-results/mongodb-harness-playground.png', fullPage: true });

  // Phone width keeps the tabs usable without horizontal scrolling.
  await page.goto('/knowledge/collections');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tab', { name: 'Collections' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(392);
  expect(errors).toEqual([]);
});

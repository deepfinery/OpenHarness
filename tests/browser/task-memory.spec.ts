import { test, expect } from '@playwright/test';

test('task notebook can be searched, read and promoted from the Playground', async ({ page }) => {
  const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
  const headers = { Origin: base };
  const api = async (path: string, data?: unknown) => {
    const response = await page.request.fetch(`/api${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers,
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  await api('/auth/login', { email: 'admin@openharness.test', password: 'Integration-test-password-42' });
  const provider = await api('/providers', {
    name: 'Memory browser model',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  const kb = await api('/knowledge', { name: 'Memory browser knowledge', providerId: provider.id });
  const workflow = await api('/workflows', {
    name: 'Memory browser workflow',
    startAt: 'agent',
    nodes: [
      {
        id: 'agent',
        name: 'Researcher',
        type: 'agent',
        config: { name: 'Researcher', providerId: provider.id, systemPrompt: 'Inspect and record findings.' },
      },
    ],
    workspace: { knowledgeBaseId: kb.id },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page
    .locator('.sidebar nav')
    .getByRole('button', { name: /^Playground/ })
    .click();
  await page.getByLabel('Playground agent or workflow').selectOption(`workflow:${workflow.id}`);
  await page.getByLabel('Message your agent').fill('task notebook roundtrip');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.chat-message.assistant .markdown').last()).toContainText('immediate evidence');
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await expect(page.locator('.task-memory')).toContainText('Temporary notes expire after seven days');
  await page.getByLabel('Search task memory').fill('immediate');
  await page.getByRole('button', { name: 'Search / refresh' }).click();
  await page.locator('.task-memory .history-item').filter({ hasText: 'Immediate finding' }).click();
  await expect(page.locator('.task-memory .markdown')).toContainText('verified fixture fact');
  await page.getByRole('button', { name: 'Keep in long-term memory' }).click();
  await expect(page.locator('.task-memory [role="status"]')).toContainText('Saved to long-term memory');
  expect((await api(`/knowledge/${kb.id}/documents`)).length).toBe(1);
  expect(errors).toEqual([]);
});

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
  const secondKb = await api('/knowledge', {
    name: 'Memory browser second notebook',
    providerId: provider.id,
  });
  const workflow = await api('/workflows', {
    name: 'Memory browser workflow',
    startAt: 'agent',
    nodes: [
      {
        id: 'agent',
        name: 'Researcher',
        type: 'agent',
        config: {
          name: 'Researcher',
          providerId: provider.id,
          systemPrompt: 'Inspect and record findings.',
          knowledgeBaseIds: [kb.id, secondKb.id],
        },
      },
    ],
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
  await expect(page.getByRole('button', { name: 'Keep in long-term memory' })).toBeDisabled();
  await page.getByLabel('Save to notebook').selectOption(secondKb.id);
  await page.getByRole('button', { name: 'Keep in long-term memory' }).click();
  await expect(page.locator('.task-memory [role="status"]')).toContainText('Saved to long-term memory');
  const documents = await api(`/knowledge/${kb.id}/documents`);
  expect(
    (await api(`/knowledge/${secondKb.id}/documents`)).filter((doc: any) => doc.meta?.task_note_id),
  ).toHaveLength(1);
  expect(documents.filter((doc: any) => doc.meta?.task_note_id)).toHaveLength(0);
  expect(documents.filter((doc: any) => doc.meta?.record_type === 'experiment')).toHaveLength(1);
  await expect(page.locator('.memory-summary')).toContainText('experiment record saved');

  // Older saved conversations can contain the harness's former JSON-dump fallback.
  // Render it readably on reopen without changing the stored transcript or evidence.
  let historicalId = '';
  await page.route('**/api/conversations/*', async (route) => {
    const response = await route.fetch();
    const conversation = await response.json();
    historicalId = conversation.id;
    conversation.messages = conversation.messages.map((message: any) =>
      message.role === 'assistant'
        ? {
            ...message,
            content:
              'Analysis stopped at its configured limit, and the model did not provide a final summary. The assessment is incomplete.\n\n- run_command: {"content":[{"type":"text","text":"TRUNCATED TRANSPORT DATA',
          }
        : message,
    );
    await route.fulfill({ response, json: conversation });
  });
  await page.reload();
  const answer = page.locator('.chat-message.assistant .markdown').last();
  await expect(answer).toContainText('This assessment is incomplete.');
  await expect(answer).toContainText('Memory and Trace');
  await expect(answer).not.toContainText('TRUNCATED TRANSPORT DATA');
  await expect(answer).not.toContainText('"content"');
  const stored = await api(`/conversations/${historicalId}`);
  expect(stored.messages.at(-1).content).toContain('immediate evidence');
  expect(errors).toEqual([]);
});

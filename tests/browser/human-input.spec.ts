import { test, expect } from '@playwright/test';
test('Playground answers a paused question and Inbox reviews edited tool arguments', async ({ page }) => {
  const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
  const api = async (path: string, data?: unknown) => {
    const r = await page.request.fetch('/api' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: base },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  await api('/auth/login', { email: 'admin@openharness.test', password: 'Integration-test-password-42' });
  const credentials = {
    email: `human-browser-${Date.now()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await api('/users', { ...credentials, name: 'Browser test', workspace: 'new' });
  await api('/auth/login', credentials);
  const p = await api('/providers', {
    name: 'Human browser model',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  const c = await api('/connections', { name: 'Human browser tools', url: 'http://fixtures:9090/mcp' });
  await api(`/connections/${c.id}/discover`, {});
  const w = await api('/workflows', {
    name: 'Human browser workflow',
    startAt: 'agent',
    nodes: [
      {
        id: 'agent',
        name: 'Researcher',
        type: 'agent',
        config: {
          name: 'Researcher',
          providerId: p.id,
          systemPrompt: 'Ask for input',
          connections: [{ connectionId: c.id, tools: ['lookup'] }],
          approvals: { mode: 'always' },
        },
        prompt: '{{last}}',
      },
    ],
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/playground');
  await page.getByLabel('Playground agent or workflow').selectOption(`workflow:${w.id}`);
  await page.getByLabel('Message your agent').fill('human checkpoint test');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByLabel('Human input request')).toContainText('Which region');
  await page.getByLabel('Human answer').fill('Europe');
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(page.locator('.chat-message.assistant .markdown').last()).toContainText('Europe');
  const run = await api('/runs', { workflowId: w.id, input: 'human approval test' });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByLabel('Human input request')).toContainText('Approve');
  await page.getByLabel('Approval arguments').fill('{"query":"browser approved edit"}');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('No pending requests.')).toBeVisible();
  await expect
    .poll(async () => (await api(`/runs/${run.id}`)).output ?? '')
    .toContain('browser approved edit');
  expect(errors).toEqual([]);
});

import { test, expect } from '@playwright/test';
test('create a safety policy and connect its box above the workflow agent', async ({ page }) => {
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
    email: `guard-browser-${Date.now()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await api('/users', { ...credentials, name: 'Safety admin', workspace: 'new', role: 'admin' });
  await api('/auth/login', credentials);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/guardrails');
  await page.getByRole('button', { name: 'New policy', exact: true }).click();
  await page.getByLabel('Policy name', { exact: true }).fill('GPU safety');
  await page.getByLabel('Guardrail provider').selectOption('builtin');
  await page.getByLabel('deniedTools').fill('gpu_reset');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'GPU safety', exact: true })).toBeVisible();
  const policies = await api('/guardrails');
  const policy = policies.find((p: any) => p.name === 'GPU safety');
  const provider = await api('/providers', {
    name: 'Safety browser model',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-model',
  });
  const workflow = await api('/workflows', {
    name: 'GPU diagnosis',
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'agent' },
      {
        id: 'agent',
        name: 'Operator',
        type: 'agent',
        config: { name: 'Operator', providerId: provider.id, systemPrompt: 'Inspect safely.' },
        next: 'finish',
      },
      { id: 'finish', name: 'Finish', type: 'finish' },
    ],
  });
  await page.goto('/workflows');
  await page
    .locator('.workflow-card')
    .filter({ has: page.locator('.card-name', { hasText: 'GPU diagnosis' }) })
    .getByRole('button', { name: /open/i })
    .click();
  await page.getByRole('button', { name: 'Add GPU safety', exact: true }).click();
  const rail = page.locator('.harness-card.kind-guardrail');
  const agent = page.locator('.harness-card.kind-agent');
  await expect(rail).toBeVisible();
  await expect(page.getByTestId('port-agent-guardrail')).toBeVisible();
  const railBox = (await rail.boundingBox())!,
    agentBox = (await agent.boundingBox())!;
  expect(railBox.y + railBox.height).toBeLessThan(agentBox.y);
  await rail.dblclick();
  await expect(page.getByLabel('Guardrail policy', { exact: true })).toHaveValue(policy.id);
  // Close card settings while keeping the workflow editor open.
  await page.getByRole('dialog').last().getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = await api(`/workflows/${workflow.id}`);
  expect(saved.resources.find((r: any) => r.type === 'guardrail').policyId).toBe(policy.id);
  expect(saved.bindings).toContainEqual({ agentNodeId: 'agent', resourceId: saved.resources[0].id });
  expect(errors).toEqual([]);
});

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
  await page.getByRole('button', { name: 'Use Vulnerability template', exact: true }).click();
  await page.getByLabel('Policy name', { exact: true }).fill('GPU safety');
  await page.getByLabel('Guardrail provider').selectOption('builtin');
  await page.getByText('Advanced rules & service settings', { exact: true }).click();
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

test('template gallery creates editable policies, previews PII, and fits mobile screens', async ({
  page,
}) => {
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
    email: `templates-browser-${Date.now()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await api('/users', { ...credentials, name: 'Template admin', workspace: 'new', role: 'admin' });
  await api('/auth/login', credentials);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/guardrails');
  await expect(page.getByRole('heading', { name: 'Start with a safety template' })).toBeVisible();
  await expect(page.locator('.guardrail-template')).toHaveCount(6);
  await page.screenshot({ path: 'test-results/guardrail-template-gallery.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/guardrail-template-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const name of ['Bias', 'Toxicity', 'Hallucinations', 'Opacity', 'PII presence', 'Vulnerability']) {
    await page.getByRole('button', { name: 'Policy templates', exact: true }).click();
    await page.getByRole('button', { name: `Use ${name} template`, exact: true }).click();
    await expect(page.getByLabel('Policy name', { exact: true })).toHaveValue(`${name} policy`);
    if (name === 'Bias') {
      await expect(page.getByLabel('Safety instructions', { exact: true })).toHaveValue(/discriminatory/);
      await page
        .getByLabel('Safety instructions', { exact: true })
        .fill('Block unfair discriminatory recommendations.');
      await page.getByLabel('Guardrail provider').selectOption('builtin');
      await expect(page.getByLabel('Safety instructions', { exact: true })).toHaveValue(
        'Block unfair discriminatory recommendations.',
      );
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('alert').last()).toContainText('Safety instructions require NeMo');
      await page.getByLabel('Guardrail provider').selectOption('nemo');
      await page.getByRole('checkbox', { name: /Safety model checks/ }).check();
      await page.screenshot({ path: 'test-results/guardrail-template-editor.png', fullPage: true });
    }
    if (name === 'PII presence') {
      await page.getByRole('button', { name: 'Try it out', exact: true }).click();
      await page.getByRole('button', { name: 'Check content', exact: true }).click();
      await expect(page.locator('.guardrail-preview')).toContainText('[EMAIL]');
      await expect(page.locator('.guardrail-preview')).not.toContainText('alice@example.com');
    }
    await page.getByRole('button', { name: 'Save policy', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: `${name} policy`, exact: true })).toBeVisible();
  }
  await page.reload();
  const card = page
    .locator('.guardrail-template')
    .filter({ has: page.getByRole('heading', { name: 'Bias policy', exact: true }) });
  await card.getByRole('button', { name: 'Edit policy' }).click();
  await expect(page.getByLabel('Safety instructions', { exact: true })).toHaveValue(
    'Block unfair discriminatory recommendations.',
  );
  await page.getByLabel('Policy name', { exact: true }).fill('Hiring fairness');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Search policies').fill('Hiring');
  await expect(page.locator('.guardrail-template')).toHaveCount(1);
  await page.getByLabel('Search policies').fill('');
  await page.screenshot({ path: 'test-results/guardrail-policy-library.png', fullPage: true });
  const saved = await api('/guardrails');
  expect(saved).toHaveLength(6);
  expect(saved.find((p: any) => p.name === 'Hiring fairness').templateId).toBe('bias');
  expect(errors).toEqual([]);
});

test('policy YAML synchronizes form edits, validates drafts, and imports and exports files', async ({
  page,
}) => {
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
    email: `yaml-browser-${Date.now()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await api('/users', { ...credentials, name: 'YAML admin', workspace: 'new', role: 'admin' });
  await api('/auth/login', credentials);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/guardrails');
  await page.getByRole('button', { name: 'Use PII presence template', exact: true }).click();
  await page.getByLabel('Policy name', { exact: true }).fill('Research privacy');
  await page.getByRole('button', { name: 'Policy YAML', exact: true }).click();
  const yaml = page.getByLabel('Policy YAML content', { exact: true });
  const initial = await yaml.inputValue();
  expect(initial).toContain('name: Research privacy');
  expect(initial).toContain('custom_data:');
  await yaml.fill(
    initial
      .replace('name: Research privacy', 'name: Support privacy')
      .replace('timeoutMs: 5000', 'timeoutMs: 4500'),
  );
  await page.getByRole('button', { name: 'Configure policy', exact: true }).click();
  await expect(page.getByLabel('Policy name', { exact: true })).toHaveValue('Support privacy');
  await page.getByText('Advanced rules & service settings', { exact: true }).click();
  await expect(page.getByLabel('Timeout (ms)', { exact: true })).toHaveValue('4500');
  await page.getByLabel('Timeout (ms)', { exact: true }).fill('4000');
  await page.getByRole('button', { name: 'Policy YAML', exact: true }).click();
  const current = await yaml.inputValue();
  expect(current).toContain('timeoutMs: 4000');
  await yaml.fill(current + '\nimport_paths: [/etc]');
  await expect(page.getByRole('button', { name: 'Save policy', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export YAML', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Try it out', exact: true }).click();
  await expect(yaml).toBeVisible();
  await page.getByRole('button', { name: 'Restore last valid policy', exact: true }).click();
  await expect(yaml).toHaveValue(current);
  await page.screenshot({
    path: 'test-results/guardrail-yaml-editor.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Try it out', exact: true }).click();
  await page.getByRole('button', { name: 'Check content', exact: true }).click();
  await expect(page.locator('.guardrail-preview')).toContainText('[EMAIL]');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export YAML', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('support-privacy.yaml');
  let exported = '';
  const stream = await download.createReadStream();
  for await (const chunk of stream!) exported += chunk.toString();
  expect(exported).toContain('timeoutMs: 4000');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let saved = await api('/guardrails');
  expect(saved).toHaveLength(1);
  expect(saved[0].timeoutMs).toBe(4000);
  const choose = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import YAML', exact: true }).click();
  await (
    await choose
  ).setFiles({
    name: 'imported.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(exported.replace('name: Support privacy', 'name: Imported privacy')),
  });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Policy YAML content')).toHaveValue(/name: Imported privacy/);
  expect(await api('/guardrails')).toHaveLength(1); // Import is a draft, not an immediate write.
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page
    .locator('.guardrail-template')
    .filter({ has: page.getByRole('heading', { name: 'Imported privacy', exact: true }) })
    .getByRole('button', { name: 'Edit policy' })
    .click();
  await page.getByRole('button', { name: 'Policy YAML', exact: true }).click();
  await expect(page.getByLabel('Policy YAML content')).toHaveValue(/timeoutMs: 4000/);
  const invalid = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import YAML into draft', exact: true }).click();
  await (
    await invalid
  ).setFiles({
    name: 'invalid.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from('models: !!python/object {}'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Policy YAML content')).toHaveValue(/name: Imported privacy/);
  await page.getByRole('button', { name: 'Configure policy', exact: true }).click();
  await page.getByLabel('Policy name', { exact: true }).fill('Edited import');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  saved = await api('/guardrails');
  expect(saved).toHaveLength(2);
  expect(saved.find((p: any) => p.name === 'Edited import').timeoutMs).toBe(4000);
  expect(errors).toEqual([]);
});

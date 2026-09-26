import { test, expect } from '@playwright/test';
test('cluster setup exposes shared installation, monitoring and remediation controls', async ({ page }) => {
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
    email: `cluster-browser-${Date.now()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await api('/users', { ...credentials, name: 'Cluster admin', workspace: 'new', role: 'admin' });
  await api('/auth/login', credentials);
  await api('/providers', {
    name: 'Monitor provider',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-cluster',
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/clusters');
  await page.getByRole('button', { name: 'Create cluster', exact: true }).click();
  await page.getByLabel('Cluster name', { exact: true }).fill('Training fleet');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('DEVICE_TOKEN=cl_');
  await expect(page.getByRole('dialog')).toContainText('--host-access');
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Configure Training fleet', exact: true }).click();
  await page.getByRole('button', { name: 'New monitoring agent', exact: true }).click();
  await page.getByLabel('Monitoring agent name').fill('GPU troubleshooter');
  await page.getByRole('button', { name: 'Save monitoring agent', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByLabel('Monitoring agent')).toHaveValue((await api('/agents'))[0].id);
  await expect(page.getByLabel('Interval (seconds)')).toHaveValue('300');
  await expect(page.getByLabel('Remediation mode')).toHaveValue('disabled');
  await page.getByLabel('Remediation mode').selectOption('approval');
  await page.getByLabel('gpu reset', { exact: true }).check();
  await page.getByRole('button', { name: 'Save cluster', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const result = await api('/clusters');
  expect(result.clusters[0].remediation).toBe('approval');
  expect(result.clusters[0].actions).toEqual(['gpu_reset']);
  expect(result.clusters[0].monitor.enabled).toBe(false);
  expect(errors).toEqual([]);
});

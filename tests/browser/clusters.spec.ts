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
  await expect(page.getByRole('dialog', { name: 'Cluster: Training fleet', exact: true })).toBeVisible();
  await expect(page.getByLabel('Monitoring agent', { exact: true })).toHaveValue(
    (await api('/agents'))[0].id,
  );
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
  await page.getByRole('button', { name: /^Machines\s*0$/ }).click();
  await page.getByRole('button', { name: 'Add machine', exact: true }).first().click();
  await page.getByLabel('Machine name', { exact: true }).fill('Standalone diagnostics');
  await page.getByLabel('Machine ID', { exact: true }).fill(`ui-node-${Date.now()}`);
  await page.getByRole('button', { name: 'Read-only tools', exact: true }).click();
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Waiting for the machine to connect');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Configure Standalone diagnostics', exact: true }).click();
  await page.getByLabel('Machine name', { exact: true }).fill('Standalone inspector');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.fleet-table')).toContainText('Standalone inspector');
  expect((await api('/devices')).machines[0].name).toBe('Standalone inspector');
  expect(errors).toEqual([]);
});

test('unified inventory groups cluster nodes, filters large fleets, and preserves deep links', async ({
  page,
}) => {
  const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: base },
    data: { email: 'admin@openharness.test', password: 'Integration-test-password-42' },
  });
  expect(login.ok()).toBeTruthy();
  const clusters = [
    {
      _id: 'training',
      name: 'Training · H100',
      node_count: 27,
      max_nodes: 2000,
      disabled: false,
      remediation: 'approval',
      actions: [],
      cooldown_seconds: 300,
      monitor: { enabled: true, intervalSeconds: 300 },
    },
    {
      _id: 'inference',
      name: 'Inference · production',
      node_count: 1,
      max_nodes: 100,
      disabled: false,
      remediation: 'disabled',
      actions: [],
      cooldown_seconds: 300,
    },
    {
      _id: 'staging',
      name: 'Staging · validation',
      node_count: 0,
      max_nodes: 20,
      disabled: true,
      remediation: 'disabled',
      actions: [],
      cooldown_seconds: 300,
    },
  ];
  const machines = Array.from({ length: 30 }, (_, i) => ({
    device_id: `node-${i}`,
    name:
      i < 27
        ? `GPU worker ${String(i + 1).padStart(3, '0')}`
        : i === 27
          ? 'Inference worker'
          : i === 28
            ? 'Operations workstation'
            : 'Browser test runner',
    cluster_id: i < 27 ? 'training' : i === 27 ? 'inference' : undefined,
    platform: i === 28 ? 'windows' : i === 29 ? 'chrome' : 'linux',
    hostname: `node-${i}.internal`,
    online: i % 4 !== 0,
    disabled: i === 28,
    connector_version: '0.2.0',
    last_seen: '2026-09-26T12:00:00Z',
    allowed_tools: ['host_diagnostics'],
    tools: [{ name: 'host_diagnostics' }],
    connectionId: 'fixture-connection',
  }));
  await page.route('**/api/clusters', (route) => route.fulfill({ json: { clusters } }));
  let outage = false;
  await page.route('**/api/devices', (route) =>
    outage
      ? route.fulfill({ status: 503, json: { error: 'Fixture gateway unavailable' } })
      : route.fulfill({
          json: { configured: true, publicUrl: 'ws://localhost:18090', catalog: {}, machines },
        }),
  );
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/clusters');
  await expect(page.getByRole('heading', { name: 'Machines & clusters', exact: true })).toBeVisible();
  await expect(
    page.locator('.sidebar nav').getByRole('button', { name: 'Machines & clusters', exact: true }),
  ).toHaveCount(1);
  await expect(
    page.locator('.sidebar nav').getByRole('button', { name: 'Clusters', exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/\/machines\?view=clusters$/);
  await page.locator('.sidebar nav').getByRole('button', { name: 'Machines & clusters', exact: true }).click();
  await expect(page).toHaveURL(/\/machines\?view=clusters$/);
  await expect(page.locator('.fleet-cluster-card')).toHaveCount(3);
  await page.screenshot({
    path: 'test-results/fleet-clusters-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'View nodes in Training · H100', exact: true }).click();
  await expect(page.getByLabel('Filter by cluster')).toHaveValue('training');
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Configure GPU worker 026', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('cluster’s shared token');
  await expect(page.getByRole('button', { name: 'New token', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Filter machines').fill('GPU worker 001');
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(1);
  await page.getByLabel('Filter machines').fill('');
  await page.getByLabel('Filter by status').selectOption('online');
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(20);
  await page.reload();
  await expect(page.getByLabel('Filter by cluster')).toHaveValue('training');
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(25);
  await page.getByLabel('Filter by cluster').selectOption('standalone');
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(2);
  await page.getByLabel('Filter by platform').selectOption('windows');
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(1);
  await page.getByLabel('Filter by status').selectOption('online');
  await expect(page.getByRole('heading', { name: 'No machines match these filters' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click();
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(25);
  await page.screenshot({
    path: 'test-results/fleet-machines-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({
    path: 'test-results/fleet-machines-mobile.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: /^Clusters\s*3$/ }).click();
  await expect(page.locator('.fleet-cluster-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({
    path: 'test-results/fleet-clusters-mobile.png',
    fullPage: false,
    animations: 'disabled',
  });
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Machine inventory' })).toBeVisible();
  outage = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('gateway unavailable');
  await expect(page.locator('.fleet-table tbody tr')).toHaveCount(25);
  expect(errors).toEqual([]);
});

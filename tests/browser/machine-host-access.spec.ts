import { test, expect } from '@playwright/test';
test('machine settings expose restricted and privileged host installation and reusable credentials', async ({
  page,
}) => {
  const base = process.env.TEST_BASE_URL ?? 'http://localhost:18088';
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
  const user = {
    email: `host-browser-${Date.now()}@openharness.test`,
    password: 'Integration-test-password-42',
  };
  await api('/users', { ...user, name: 'Host admin', workspace: 'new', role: 'admin' });
  await api('/auth/login', user);
  await page.goto('/machines');
  await page.getByRole('button', { name: 'Add machine', exact: true }).first().click();
  await page.getByRole('radio', { name: /Container/ }).click();
  await page.getByLabel('Machine name').fill('VM2');
  await page.getByLabel('Machine ID', { exact: true }).fill(`vm2-${Date.now()}`);
  await page.getByLabel('Machine access', { exact: true }).selectOption('host');
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('--privileged --pid=host --user 0');
  await expect(page.getByRole('dialog')).toContainText('MACHINE_ACCESS_MODE=host');
  await page.getByLabel('Harness gateway address').fill('ws://192.0.2.45:8090');
  await expect(page.getByRole('dialog')).toContainText('GATEWAY_URL=ws://192.0.2.45:8090/connect');
  const token = await page.getByLabel('Device token', { exact: true }).inputValue();
  expect(token).toMatch(/^dv_/);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Configure VM2', exact: true }).click();
  await expect(page.getByLabel('Machine access', { exact: true })).toHaveValue('host');
  await page.getByRole('button', { name: 'Installation instructions', exact: true }).click();
  await page.getByLabel('Device token', { exact: true }).fill(token);
  await expect(page.getByRole('dialog')).toContainText(`DEVICE_TOKEN=${token}`);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Configure VM2', exact: true }).click();
  await page.getByLabel('Machine access', { exact: true }).selectOption('restricted');
  await page.getByRole('button', { name: 'Installation instructions', exact: true }).click();
  await page.getByRole('button', { name: 'Container', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('MACHINE_ACCESS_MODE=restricted');
  await expect(page.getByRole('dialog')).not.toContainText('--privileged');
  expect((await api('/devices')).machines[0].access_mode).toBe('restricted');
});

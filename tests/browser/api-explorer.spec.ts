import { test, expect } from '@playwright/test';
test('Harnesses navigation and API explorer send a real request and expose the contract', async ({
  page,
}) => {
  const base = process.env.TEST_BASE_URL ?? 'http://localhost:18088';
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: base },
    data: { email: 'admin@openharness.test', password: 'Integration-test-password-42' },
  });
  expect(login.ok()).toBeTruthy();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/harnesses');
  await expect(page.getByRole('heading', { name: 'Harnesses', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create harness', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Integrations', exact: true }).click();
  await page.getByRole('button', { name: /API explorer Explore/ }).click();
  await expect(page.getByRole('heading', { name: 'Open Harness API', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send GET', exact: true }).click();
  await expect(page.getByLabel('API response')).toContainText('"data"');
  await page.getByLabel('Search API endpoints').fill('memory');
  await expect(page.getByRole('navigation', { name: 'API endpoints' }).getByRole('button')).not.toHaveCount(
    0,
  );
  await page.getByLabel('Search API endpoints').fill('Execute Task');
  await page
    .getByRole('navigation', { name: 'API endpoints' })
    .getByRole('button', { name: 'POST Execute Task', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Request body' })).toHaveValue(/"message": "Hello"/);
  await page.getByLabel('Search API endpoints').fill('Create Session');
  await page.getByRole('navigation', { name: 'API endpoints' }).getByRole('button').click();
  await expect(page.getByRole('button', { name: 'Send POST', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Request body' })).toBeVisible();
  await page.screenshot({ path: 'test-results/harness-api-explorer.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Open Harness API', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(392);
  expect(errors).toEqual([]);
});

import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';

const answer = [
  '# Capacity report',
  'A **formatted** answer with a [reference](https://example.com/report).',
  '| Service | Region | Capacity | Status | Notes |\n| --- | --- | --- | --- | --- |\n' +
    Array.from(
      { length: 70 },
      (_, i) =>
        `| Service ${i + 1} | North America | ${100 + i} nodes | Healthy | Readable details for the capacity planning report, including longer descriptions. |`,
    ).join('\n'),
  '```text\n' + 'long-command-'.repeat(45) + '\n```',
  '- First finding\n- Last finding',
  'FINAL TRANSCRIPT SENTINEL',
].join('\n\n');

async function fixture(
  page: Page,
  messages = [
    { role: 'user', content: 'Please produce a capacity report.' },
    { role: 'assistant', content: answer, runId: 'run-1' },
  ],
) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    const values: Record<string, unknown> = {
      '/auth/status': { needsSetup: false },
      '/auth/me': { id: 'user-1', tenantId: 'tenant-1', role: 'admin', name: 'Export tester' },
      '/tenant': { name: 'Test workspace' },
      '/devices': { machines: [], catalog: {} },
      '/inbox': { requests: [] },
      '/health': { status: 'ok' },
      '/workflows': [{ id: 'workflow-1', name: 'Capacity assistant', nodes: [] }],
      '/conversations': messages.length
        ? [{ id: 'conversation-1', title: 'Capacity review', messageCount: messages.length }]
        : [],
      '/conversations/conversation-1': { id: 'conversation-1', messages },
      '/runs/run-1': { id: 'run-1', status: 'succeeded', output: answer, events: [] },
    };
    await route.fulfill({ json: values[path] ?? [] });
  });
  await page.goto('/playground');
  await expect(page.getByLabel('Message your agent')).toBeEnabled();
}

test('copy a message and the complete conversation with rich text and Markdown fallback', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fixture(page);
  await page.getByRole('button', { name: 'Copy message', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Copy message', exact: true }).last()).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(answer);
  const rich = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return (await items[0].getType('text/html')).text();
  });
  expect(rich).toContain('<table>');
  expect(rich).toContain('<strong>formatted</strong>');
  expect(rich).not.toContain('View activity');
  await page.getByRole('button', { name: 'Copy conversation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy conversation', exact: true })).toHaveAttribute(
    'title',
    'Copied',
  );
  const transcript = await page.evaluate(() => navigator.clipboard.readText());
  expect(transcript).toContain('# Capacity review');
  expect(transcript).toContain('## You\n\nPlease produce');
  expect(transcript).toContain('FINAL TRANSCRIPT SENTINEL');
  await page.evaluate(() => {
    navigator.clipboard.write = async () => {
      throw new Error('Rich clipboard unavailable');
    };
  });
  await page.getByRole('button', { name: 'Copy message', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Copy message', exact: true }).first()).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Please produce a capacity report.');
});

test('download contains all messages and clipboard denial provides recovery', async ({ page }) => {
  await fixture(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Markdown' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('Capacity-review.md');
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain(answer);
  expect(text).not.toContain('View activity');
  await page.evaluate(() => {
    navigator.clipboard.write = async () => {
      throw new Error('Denied');
    };
    navigator.clipboard.writeText = async () => {
      throw new Error('Denied');
    };
  });
  await page.getByRole('button', { name: 'Copy conversation', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Copy unavailable' })).toBeVisible();
});

test('conversation and tables expand with the window and remain usable on mobile', async ({ page }) => {
  await fixture(page);
  await expect(page.locator('.topbar').getByRole('group', { name: 'Conversation export' })).toBeVisible();
  await expect(page.locator('.playground-main .conversation-export')).toHaveCount(0);
  const header = (await page.locator('.topbar').boundingBox())!;
  expect((await page.locator('.chat-scroll').boundingBox())!.y).toBeCloseTo(header.y + header.height, 0);
  await page.getByRole('button', { name: 'Hide trace panel' }).click();
  const message = page.locator('.chat-message.assistant');
  await page.setViewportSize({ width: 1200, height: 900 });
  const narrow = (await message.boundingBox())!.width;
  await page.setViewportSize({ width: 2000, height: 1000 });
  const wide = (await message.boundingBox())!.width;
  expect(wide - narrow).toBeGreaterThan(650);
  expect((await message.locator('table').boundingBox())!.width).toBeGreaterThan(1200);
  await page.screenshot({ path: test.info().outputPath('wide-playground.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Print / Save as PDF' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const table = message.locator('.markdown-table');
  expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBeTruthy();
  await expect(page.locator('.sidebar')).not.toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('mobile-playground.png') });
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Print options', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Print options' })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Print options' })).toBeHidden();
});

test('print and PDF include the full formatted transcript without application panels', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printRequested = 'true';
    };
  });
  await page.getByRole('button', { name: 'Print / Save as PDF' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-print-requested', 'true');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.app-shell')).toBeHidden();
  await expect(page.locator('.playground-print')).toBeVisible();
  await expect(page.locator('.playground-print')).toContainText('FINAL TRANSCRIPT SENTINEL');
  await expect(page.locator('.playground-print table tr')).toHaveCount(71);
  await expect(page.locator('.playground-print table')).toHaveCSS('display', 'table');
  await expect(page.locator('.playground-print table')).toHaveCSS('font-size', '13.3333px');
  expect((await page.locator('.playground-print table').boundingBox())!.width).toBeCloseTo(
    (await page.locator('.playground-print').boundingBox())!.width,
    0,
  );
  const pdf = await page.pdf({
    path: test.info().outputPath('portrait.pdf'),
    preferCSSPageSize: true,
    printBackground: true,
  });
  expect(pdf.length).toBeGreaterThan(10000);
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Print options', exact: true }).click();
  await page.getByLabel('Print page layout').selectOption('landscape');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: test.info().outputPath('landscape.pdf'),
    preferCSSPageSize: true,
    printBackground: true,
  });
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('button', { name: 'Harnesses', exact: false }).first().click();
  await expect(page.locator('.playground-print')).toHaveCount(0);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('empty conversations cannot be exported', async ({ page }) => {
  await fixture(page, []);
  await expect(page.getByRole('button', { name: 'Copy conversation', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download Markdown' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Print / Save as PDF' })).toBeDisabled();
});

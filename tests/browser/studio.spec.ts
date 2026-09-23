import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('admin@agentic.test');
  await page.getByLabel('Password', { exact: true }).fill('Integration-test-password-42');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'From intent to action.' })).toBeVisible();
});

test('trimmed navigation, providers, agents and connections load without browser exceptions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.screenshot({ path: 'test-results/studio-workflows.png', fullPage: true });
  for (const [nav, heading] of [
    ['Agents', 'Your agents.'],
    ['MCP connections', 'MCP connections.'],
    ['Knowledge bases', 'A library for your agents.'],
    ['Executions', 'Executions.'],
    ['Integrations', 'Take your agents anywhere.'],
    ['Settings', 'Settings.'],
  ]) {
    await page
      .locator('nav')
      .getByRole('button', { name: new RegExp('^' + nav + '( \\d+)?$') })
      .click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'My profile', exact: true }).click();
  await expect(page.getByLabel('Profile email')).toHaveValue('admin@agentic.test');
  await expect(page.locator('nav')).not.toContainText(/Customers|Billing|Reports|Website|Wizard|Portal/);
  expect(errors).toEqual([]);
});

test('agent creation selects discovered MCP tools and runs in the playground', async ({ page }) => {
  await page
    .locator('nav')
    .getByRole('button', { name: /^Agents(?: \d+)?$/ })
    .click();
  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an agent' });
  const name = `Browser Assistant ${Date.now()}`;
  await dialog.getByLabel('Agent name').fill(name);
  await dialog.getByLabel('Agent description').fill('Browser-tested MCP assistant');
  const providerOptions = await dialog.getByLabel('Agent model provider').locator('option').allTextContents();
  const fixtureOption = providerOptions.find((p) => p.includes('test-chat'))!;
  await dialog.getByLabel('Agent model provider').selectOption({ label: fixtureOption });
  const group = dialog.locator('.tool-group').filter({ hasText: 'MCP tools' }).first();
  await group.locator('summary').click();
  await group.getByRole('checkbox', { name: /lookup/ }).check();
  await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const card = page.locator('.agent-card').filter({ hasText: name });
  await card.getByRole('button', { name: 'Try in playground' }).click();
  await page.getByLabel('Message your agent').fill('Please use tool for a browser test');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.chat-message.assistant .markdown')).toContainText('MCP lookup', {
    timeout: 30000,
  });
  await expect(page.locator('.trace-heading')).toContainText('succeeded');
  await page.screenshot({ path: 'test-results/studio-playground.png', fullPage: true });
});

test('workflow graph editor saves a runnable agent flow and persists dragged positions', async ({ page }) => {
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Workflow editor' });
  const name = `Browser Flow ${Date.now()}`;
  await page.getByLabel('Workflow name').fill(name);
  await editor.getByRole('button', { name: 'Agent Reason and act' }).click();
  const options = await editor.getByLabel('Step agent').locator('option').allTextContents();
  const agentName = options.find((n) => n.startsWith('Browser Assistant')) ?? options[1];
  await editor.getByLabel('Step agent').selectOption({ label: agentName });
  await editor.getByRole('button', { name: 'Auto layout' }).click();
  await expect(editor.locator('.flow-card')).toHaveCount(2);
  const cardToDrag = editor.locator('.flow-card').filter({ hasText: 'Agent step' });
  await expect(cardToDrag).toBeVisible();
  await expect(cardToDrag).toBeInViewport();
  // Auto-layout animates its viewport for 250 ms. Drag only after it settles.
  await page.waitForTimeout(400);
  const before = await cardToDrag.boundingBox();
  const outputCard = editor.locator('.flow-card').filter({ hasText: 'Final response' });
  const outputBefore = await outputCard.boundingBox();
  await page.mouse.move(before!.x + 120, before!.y + 35);
  await page.mouse.down();
  await page.mouse.move(before!.x + 175, before!.y + 95, { steps: 12 });
  await page.mouse.up();
  const after = await cardToDrag.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeGreaterThan(20);
  const outputAfter = await outputCard.boundingBox();
  expect(Math.abs(outputAfter!.y - outputBefore!.y)).toBeLessThan(2);
  await expect(cardToDrag).toBeVisible();
  await expect(cardToDrag).toBeInViewport();
  await page.screenshot({ path: 'test-results/studio-canvas.png' });
  await editor.getByRole('button', { name: 'Save workflow', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const card = page.locator('.workflow-card').filter({ hasText: name });
  await card.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByLabel('Message your agent').fill('Workflow browser question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.trace-heading')).toContainText('succeeded', { timeout: 30000 });
  await expect(page.locator('.chat-message.assistant .markdown')).toContainText(
    'Completed: Workflow browser question',
  );
});

test('knowledge files can be uploaded and searched entirely through the UI', async ({ page }) => {
  await page.locator('nav').getByRole('button', { name: 'Knowledge bases', exact: true }).click();
  await page.getByRole('button', { name: 'New knowledge base', exact: true }).click();
  const name = `Browser Knowledge ${Date.now()}`;
  await page.getByLabel('Knowledge base name').fill(name);
  await page.getByRole('button', { name: 'Save knowledge base', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.locator('.knowledge-nav').getByRole('button', { name }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'browser-handbook.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      'The Juniper project has four release stages: design, build, test, and release. Every stage has an owner.',
    ),
  });
  const row = page.getByRole('row').filter({ hasText: 'browser-handbook.md' });
  await expect(row).toContainText('ready', { timeout: 40000 });
  await page.getByLabel('Search knowledge').fill('Juniper release stages');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.knowledge-results')).toContainText('four release stages');
  await page.screenshot({ path: 'test-results/studio-knowledge.png', fullPage: true });
});

test('mobile navigation and profile remain usable without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'My profile', exact: true }).click();
  await expect(page.getByLabel('Profile name')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
  await page.screenshot({ path: 'test-results/studio-mobile.png', fullPage: true });
});

test('iframe created in the studio works without a studio login', async ({ page, browser }) => {
  await page.locator('nav').getByRole('button', { name: 'Integrations', exact: true }).click();
  await page.getByRole('button', { name: 'Iframe embeds', exact: true }).click();
  await page.getByRole('button', { name: 'Create embed', exact: true }).click();
  await page.getByLabel('Integration name').fill('Browser embed');
  const parentOrigin = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
  await page.getByLabel('Allowed embed origins').fill(parentOrigin);
  const options = await page.getByLabel('Integration target').locator('option').allTextContents();
  await page
    .getByLabel('Integration target')
    .selectOption({ label: options.find((o) => o.startsWith('Browser Assistant')) ?? options[1] });
  await page.getByRole('button', { name: 'Create embed link', exact: true }).click();
  const markup = await page.locator('.secret-value').textContent();
  const url = /src="([^"]+)"/.exec(markup!)![1];
  const context = await browser.newContext();
  const embedded = await context.newPage();
  try {
    await embedded.goto(parentOrigin + '/embed-parent');
    await embedded.setContent(
      `<iframe src="${url}" title="External agent" width="420" height="640"></iframe>`,
    );
    const frame = embedded.frameLocator('iframe');
    await expect(frame.getByLabel('Embed message', { exact: true })).toBeVisible();
    await frame.getByLabel('Embed message', { exact: true }).fill('Hello without a studio session');
    await frame.getByRole('button', { name: 'Send embed message' }).click();
    await expect(frame.locator('.embed-bubble.assistant')).toContainText('Completed:', { timeout: 30000 });
    await expect(frame.locator('nav')).toHaveCount(0);
    await expect(frame.locator('.trace-panel')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

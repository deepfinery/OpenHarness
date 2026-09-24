import { test, expect, type Locator, type Page } from '@playwright/test';

let sessionCookies: Awaited<
  ReturnType<import('@playwright/test').APIRequestContext['storageState']>
>['cookies'];
test.beforeAll(async ({ request }) => {
  const response = await request.post('/api/auth/login', {
    headers: { Origin: process.env.TEST_BASE_URL ?? 'http://localhost:8088' },
    data: { email: 'admin@agentic.test', password: 'Integration-test-password-42' },
  });
  expect(response.status()).toBe(200);
  sessionCookies = (await request.storageState()).cookies;
});
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(sessionCookies);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'From intent to action.' })).toBeVisible();
});
async function wire(page: Page, from: Locator, to: Locator) {
  await expect(from).toBeVisible();
  await expect(to).toBeVisible();
  const a = await from.boundingBox(),
    b = await to.boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 20 });
  await page.mouse.up();
}

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
  const starter = page.getByRole('dialog', { name: 'Start a workflow' });
  await starter.getByRole('button', { name: /Blank canvas/ }).click();
  await starter.getByRole('button', { name: 'Open canvas' }).click();
  const editor = page.getByRole('dialog', { name: 'Workflow editor' });
  const name = `Browser Flow ${Date.now()}`;
  await page.getByLabel('Workflow name').fill(name);
  await editor.getByRole('button', { name: 'Add AI agent', exact: true }).click();
  await editor.getByLabel('Component name').fill('Workflow assistant');
  const options = await editor.getByLabel('Workflow model provider').locator('option').allTextContents();
  await editor
    .getByLabel('Workflow model provider')
    .selectOption({ label: options.find((n) => n.includes('test-chat'))! });
  await editor.getByRole('button', { name: 'Auto layout' }).click();
  await expect(editor.locator('.flow-card')).toHaveCount(3);
  const cardToDrag = editor.locator('.flow-card').filter({ hasText: 'Workflow assistant' });
  await expect(cardToDrag).toBeVisible();
  await expect(cardToDrag).toBeInViewport();
  // Auto-layout animates its viewport for 250 ms. Drag only after it settles.
  await page.waitForTimeout(400);
  const before = await cardToDrag.boundingBox();
  const outputCard = editor.locator('.flow-card.kind-finish');
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
  await editor.locator('.flow-card.kind-start').click();
  await editor.getByLabel('Next step', { exact: true }).selectOption('');
  await expect(editor.locator('.react-flow__edge')).toHaveCount(1);
  await wire(page, editor.getByTestId('port-start-out'), editor.locator('.kind-agent [data-testid$="-in"]'));
  await expect(editor.locator('.react-flow__edge')).toHaveCount(2);
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

test('MCP starter connects tools to the agent bottom port and executes the selected tool', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
  const starter = page.getByRole('dialog', { name: 'Start a workflow' });
  await starter.getByRole('button', { name: /MCP tool assistant/ }).click();
  await starter.getByRole('button', { name: 'Connect resources' }).click();
  const name = `Browser MCP harness ${Date.now()}`;
  await starter.getByLabel('Starter workflow name').fill(name);
  const providers = await starter.getByLabel('Workflow model provider').locator('option').allTextContents();
  await starter
    .getByLabel('Workflow model provider')
    .selectOption({ label: providers.find((n) => n.includes('test-chat'))! });
  const servers = await starter.getByLabel('Resource MCP connection').locator('option').allTextContents();
  await starter
    .getByLabel('Resource MCP connection')
    .selectOption({ label: servers.find((n) => n.startsWith('MCP tools'))! });
  await starter.getByRole('checkbox', { name: /lookup/ }).check();
  await starter.getByRole('button', { name: 'Open canvas' }).click();
  const editor = page.getByRole('dialog', { name: 'Workflow editor' });
  await expect(editor.locator('.flow-card')).toHaveCount(4);
  await editor.getByRole('button', { name: 'Auto layout' }).click();
  await page.waitForTimeout(400);
  await editor.locator('.flow-card.kind-mcp').click();
  await editor.getByRole('checkbox', { name: 'Tool assistant', exact: true }).uncheck();
  await expect(editor.locator('.react-flow__edge')).toHaveCount(2);
  await wire(page, editor.getByTestId('port-tools-resource'), editor.getByTestId('port-assistant-tools'));
  await expect(editor.locator('.react-flow__edge')).toHaveCount(3);
  await expect(editor.locator('.flow-card.kind-mcp')).toContainText('1 agent connected');
  // Edge selection plus Delete must remove just the attachment; Undo restores it.
  const resourceEdge = editor.locator('.react-flow__edge').filter({ hasText: 'Tools' });
  await resourceEdge.locator('.react-flow__edge-interaction').click({ force: true });
  await page.keyboard.press('Delete');
  await expect(editor.locator('.react-flow__edge')).toHaveCount(2);
  await editor.getByRole('button', { name: 'Undo graph change', exact: true }).click();
  await expect(editor.locator('.react-flow__edge')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/studio-mcp-harness.png' });
  await editor.getByRole('button', { name: 'Save & test', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.getByLabel('Message your agent').fill('Please use tool to answer');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.chat-message.assistant .markdown')).toContainText('MCP lookup', {
    timeout: 30000,
  });
  await expect(page.locator('.trace-heading')).toContainText('succeeded');
  expect(errors).toEqual([]);
});

test('knowledge starter uploads a document inline and creates a grounded workflow', async ({ page }) => {
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
  const starter = page.getByRole('dialog', { name: 'Start a workflow' });
  await starter.getByRole('button', { name: /Knowledge research/ }).click();
  await starter.getByRole('button', { name: 'Connect resources' }).click();
  const providers = await starter.getByLabel('Workflow model provider').locator('option').allTextContents();
  const provider = providers.find((n) => n.includes('test-chat'))!;
  await starter.getByLabel('Workflow model provider').selectOption({ label: provider });
  await starter.getByRole('button', { name: 'Create knowledge base', exact: true }).click();
  const kbDialog = page.getByRole('dialog', { name: 'Create a knowledge base' });
  await kbDialog.getByLabel('Knowledge base name').fill(`Starter handbook ${Date.now()}`);
  const embeddingOptions = await kbDialog
    .getByLabel('Embedding provider')
    .locator('option')
    .allTextContents();
  await kbDialog
    .getByLabel('Embedding provider')
    .selectOption({ label: embeddingOptions.find((n) => n.startsWith(provider.split(' · ')[0] + ' · '))! });
  await kbDialog.getByRole('button', { name: 'Save knowledge base' }).click();
  await expect(kbDialog).not.toBeVisible();
  await starter.getByLabel('Upload workflow knowledge').setInputFiles({
    name: 'starter-guide.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('The Larch research guide requires five independent citations in every report.'),
  });
  await expect(starter.locator('.knowledge-readiness')).toContainText('ready', { timeout: 40000 });
  await starter.getByRole('button', { name: 'Open canvas' }).click();
  const editor = page.getByRole('dialog', { name: 'Workflow editor' });
  await expect(editor.locator('.flow-card.kind-knowledge')).toBeVisible();
  await expect(editor.getByTestId('port-assistant-knowledge')).toBeVisible();
  await editor.getByRole('button', { name: 'Save & test', exact: true }).click();
  await page.getByLabel('Message your agent').fill('What does the Larch research guide require?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.chat-message.assistant .markdown')).toContainText(
    'five independent citations',
    { timeout: 30000 },
  );
});

test('workspace admin adds a teammate who can open and edit shared workflows', async ({ page, browser }) => {
  await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Team & workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Add teammate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a teammate' });
  const email = `browser-teammate-${Date.now()}@agentic.test`;
  await dialog.getByLabel('New account name').fill('Browser teammate');
  await dialog.getByLabel('New account email').fill(email);
  await dialog.getByLabel('New account password').fill('Browser-teammate-password-42');
  await dialog.getByRole('button', { name: 'Create teammate' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: email })).toBeVisible();
  const context = await browser.newContext();
  try {
    const teammate = await context.newPage();
    await teammate.goto(process.env.TEST_BASE_URL ?? 'http://localhost:8088');
    await teammate.getByLabel('Email address').fill(email);
    await teammate.getByLabel('Password', { exact: true }).fill('Browser-teammate-password-42');
    await teammate.getByRole('button', { name: 'Sign in', exact: true }).click();
    const shared = teammate.locator('.workflow-card').filter({ hasText: 'Browser MCP harness' }).first();
    await expect(shared).toBeVisible();
    await shared.getByRole('button', { name: 'Open', exact: true }).click();
    const editor = teammate.getByRole('dialog', { name: 'Workflow editor' });
    await expect(editor.locator('.flow-card.kind-mcp')).toBeVisible();
    await editor.locator('.flow-card.kind-agent').click();
    await editor.getByLabel('Component name').fill('Shared tool assistant');
    await editor.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await teammate.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(teammate.getByRole('button', { name: 'Team & workspace', exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('webhook created in the studio runs a workflow through its scoped capability', async ({
  page,
  request,
}) => {
  await page.locator('nav').getByRole('button', { name: 'Integrations', exact: true }).click();
  await page.getByRole('button', { name: 'Webhooks', exact: true }).click();
  await page.getByRole('button', { name: 'Create webhook', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a webhook' });
  await dialog.getByLabel('Webhook name').fill(`Browser event ${Date.now()}`);
  const options = await dialog.getByLabel('Webhook target').locator('option').allTextContents();
  await dialog
    .getByLabel('Webhook target')
    .selectOption({ label: options.find((n) => n.startsWith('Browser MCP harness'))! });
  await dialog.getByLabel('Webhook input field').fill('event.message');
  await dialog.getByRole('button', { name: 'Create webhook', exact: true }).click();
  const ready = page.getByRole('dialog', { name: 'Webhook ready' });
  const url = await ready.locator('code').textContent();
  const secret = await ready.locator('.secret-value').textContent();
  const headers = { Authorization: `Bearer ${secret}` };
  const response = await request.post(url!, {
    headers,
    data: { event: { message: 'Please use tool from webhook' } },
  });
  expect(response.status()).toBe(202);
  const run = await response.json();
  await expect
    .poll(
      async () => {
        const result = await request.get(`${url}/runs/${run.id}`, { headers });
        return (await result.json()).status;
      },
      { timeout: 30000 },
    )
    .toBe('succeeded');
  const result = await (await request.get(`${url}/runs/${run.id}`, { headers })).json();
  expect(result.output).toContain('MCP lookup');
  expect(result.events).toBeUndefined();
});

test('explicit MCP actions keep argument drafts across selection and render structured results', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click();
  const starter = page.getByRole('dialog', { name: 'Start a workflow' });
  await starter.getByRole('button', { name: /Blank canvas/ }).click();
  await starter.getByRole('button', { name: 'Open canvas' }).click();
  const editor = page.getByRole('dialog', { name: 'Workflow editor' });
  await editor.getByLabel('Workflow name').fill(`Browser action ${Date.now()}`);
  await editor.getByRole('button', { name: 'Add MCP action', exact: true }).click();
  const servers = await editor.getByLabel('Action MCP connection').locator('option').allTextContents();
  await editor
    .getByLabel('Action MCP connection')
    .selectOption({ label: servers.find((n) => n.startsWith('MCP tools'))! });
  await editor.getByLabel('Action tool', { exact: true }).selectOption('calculate');
  await editor.getByLabel('Tool arguments JSON').fill('{"a":');
  await editor.locator('.flow-card.kind-finish').click();
  await editor.getByLabel('Final response template').fill('Total: {{last.sum}}');
  await editor.locator('.flow-card.kind-tool').click();
  await expect(editor.getByLabel('Tool arguments JSON')).toHaveValue('{"a":');
  await expect(editor.getByText('Enter a JSON object.', { exact: true })).toBeVisible();
  await editor.getByLabel('Tool arguments JSON').fill('{"a": 7, "b": 5}');
  await editor.getByRole('button', { name: 'Save & test', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.getByLabel('Message your agent').fill('Run the calculation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.chat-message.assistant .markdown')).toContainText('Total: 12', {
    timeout: 30000,
  });
});

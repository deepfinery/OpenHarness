import { readFileSync } from 'node:fs';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// The suite seeds its own provider, MCP connection and admin, so it runs on a fresh stack or after the
// integration suite. Fixture services answer from http://fixtures:9090 inside the Compose network.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
const tag = Date.now().toString(36);
const headers = { Origin: base };
let providerId = '';
let connectionName = '';
let sessionCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'];

function setupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  const line = readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('SETUP_TOKEN='));
  return line?.slice('SETUP_TOKEN='.length).trim() ?? '';
}
async function api(request: APIRequestContext, path: string, method = 'GET', data?: unknown) {
  const response = await request.fetch(`/api${path}`, { method, headers, data });
  expect(response.ok(), `${method} ${path} → ${response.status()} ${await response.text()}`).toBeTruthy();
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
test.beforeAll(async ({ request }) => {
  const status = await (await request.get('/api/auth/status')).json();
  if (status.needsSetup)
    await api(request, '/auth/setup', 'POST', {
      ...admin,
      name: 'Test Administrator',
      setupToken: setupToken(),
    });
  else await api(request, '/auth/login', 'POST', admin);
  const providers = await api(request, '/providers');
  let provider = providers.find((p: any) => p.name === 'Browser model');
  provider ??= await api(request, '/providers', 'POST', {
    name: 'Browser model',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  providerId = provider.id;
  connectionName = 'Browser tools';
  const connections = await api(request, '/connections');
  let connection = connections.find((c: any) => c.name === connectionName);
  connection ??= await api(request, '/connections', 'POST', {
    name: connectionName,
    url: 'http://fixtures:9090/mcp',
  });
  await api(request, `/connections/${connection.id}/discover`, 'POST', {});
  sessionCookies = (await request.storageState()).cookies;
});
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(sessionCookies);
  await page.goto('/');
  await expect(page.locator('.sidebar nav')).toBeVisible();
});
const navButton = (page: Page, label: string) =>
  page.locator('.sidebar nav').getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) });
async function selectProvider(page: Page, scope = page.locator('.modal')) {
  await scope.getByLabel('Workflow model provider').selectOption(providerId);
}
async function newBlankWorkflow(page: Page, name: string) {
  await navButton(page, 'Workflows').click();
  await page.getByRole('button', { name: 'Create workflow', exact: true }).first().click();
  const starter = page.getByRole('dialog', { name: 'Start a workflow' });
  await starter.getByRole('button', { name: /Blank canvas/ }).click();
  await starter.getByRole('button', { name: 'Open canvas' }).click();
  await expect(page.locator('.harness-card')).toHaveCount(2);
  await page.getByLabel('Workflow name').fill(name);
}
// A fixed-name workflow with the MCP lookup tool, created once through the API for tests that need a target.
const toolFlow = 'Browser tool flow';
async function ensureToolFlow(page: Page) {
  const request = page.request;
  const workflows = await api(request, '/workflows');
  if (workflows.some((w: any) => w.name === toolFlow)) return;
  const connection = (await api(request, '/connections')).find((c: any) => c.name === connectionName);
  await api(request, '/workflows', 'POST', {
    name: toolFlow,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'assistant' },
      {
        id: 'assistant',
        name: 'Tool assistant',
        type: 'agent',
        prompt: '{{input}}',
        next: 'finish',
        config: { name: 'Tool assistant', providerId, systemPrompt: 'Use tools when asked.' },
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
    resources: [
      { id: 'tools', name: connectionName, type: 'mcp', connectionId: connection.id, tools: ['lookup'] },
    ],
    bindings: [{ agentNodeId: 'assistant', resourceId: 'tools' }],
  });
  // The studio loads its data once; reload so the new workflow appears in lists and selects.
  await page.reload();
  await expect(page.locator('.sidebar nav')).toBeVisible();
}
async function chat(page: Page, message: string) {
  await page.getByLabel('Message your agent').fill(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  return page.locator('.chat-message.assistant .markdown').last();
}

test('navigation shows every studio page without browser exceptions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const [nav, landmark] of [
    ['Workflows', page.getByRole('heading', { name: 'Workflows', exact: true })],
    ['Playground', page.getByLabel('Message your agent')],
    ['Machines', page.getByRole('heading', { name: 'Machines', exact: true })],
    ['Skills', page.getByRole('heading', { name: 'Skills', exact: true })],
    ['MCP connections', page.getByRole('heading', { name: 'MCP connections', exact: true })],
    ['Knowledge', page.locator('.topbar button[aria-label="New knowledge base"]')],
    ['Executions', page.getByRole('heading', { name: 'Executions', exact: true })],
    ['Integrations', page.getByRole('heading', { name: 'Integrations', exact: true })],
    ['Settings', page.getByRole('heading', { name: 'Settings', exact: true })],
  ] as const) {
    await navButton(page, nav).click();
    await expect(landmark).toBeVisible();
  }
  await expect(navButton(page, 'Agents')).toHaveCount(0);
  await expect(page.locator('.sidebar nav')).not.toContainText(
    /Customers|Billing|Reports|Website|Wizard|Portal/,
  );
  await page.getByRole('button', { name: 'My profile', exact: true }).click();
  await expect(page.getByLabel('Profile email')).toHaveValue(admin.email);
  expect(errors).toEqual([]);
});

test('workflow designer drops MCP tools onto an agent, keeps dragged positions and runs in the playground', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const name = `Browser flow ${tag}`;
  await newBlankWorkflow(page, name);
  await expect(page.locator('.node-inspector')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add AI agent', exact: true }).click();
  const agent = page.locator('.harness-card.kind-agent');
  await expect(agent).toBeVisible();
  await page.dragAndDrop(`button[aria-label="Add ${connectionName}"]`, '.harness-card.kind-agent');
  await expect(page.locator('.harness-card.kind-mcp', { hasText: connectionName })).toBeVisible();
  await agent.dblclick();
  const modal = page.locator('.modal');
  await selectProvider(page, modal);
  await expect(modal.locator('.effort-control button')).toHaveCount(6);
  await modal.locator('.effort-control button', { hasText: /^High$/ }).click();
  await modal.getByLabel('Component name').fill('Workflow assistant');
  await modal.getByRole('button', { name: 'Done' }).click();
  await expect(agent).toContainText('High effort');
  await page.getByRole('button', { name: /auto layout/i }).click();
  await page.waitForTimeout(400);
  const before = (await agent.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + 110, { steps: 12 });
  await page.mouse.up();
  const after = (await agent.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workflow editor' })).toHaveCount(0);
  const saved = (await api(page.request, '/workflows')).find((w: any) => w.name === name);
  const node = saved.nodes.find((n: any) => n.type === 'agent');
  expect(node.config.effort).toBe('high');
  expect(saved.bindings).toHaveLength(1);
  expect(node.position).toBeTruthy();
  await navButton(page, 'Playground').click();
  await page.locator('select[aria-label="Playground agent or workflow"]').selectOption({ label: name });
  await expect(page.locator('.chat-welcome h2')).toHaveText(name);
  await expect(await chat(page, 'Please use tool for a browser test')).toContainText('MCP lookup', {
    timeout: 30000,
  });
  await expect(page.locator('.trace-meta')).toContainText('succeeded');
  expect(errors).toEqual([]);
});

test('MCP starter connects selected tools and executes them from Save & test', async ({ page }) => {
  await navButton(page, 'Workflows').click();
  await page.getByRole('button', { name: 'Create workflow', exact: true }).first().click();
  const starter = page.getByRole('dialog', { name: 'Start a workflow' });
  await starter.getByRole('button', { name: /MCP tool assistant/ }).click();
  await starter.getByRole('button', { name: 'Connect resources' }).click();
  await starter.getByLabel('Starter workflow name').fill(`Browser MCP harness ${tag}`);
  await selectProvider(page, starter);
  await starter.getByLabel('Resource MCP connection').selectOption({ label: connectionName });
  await starter.getByRole('checkbox', { name: /lookup/ }).check();
  await starter.getByRole('button', { name: 'Open canvas' }).click();
  await expect(page.locator('.harness-card.kind-mcp')).toBeVisible();
  await expect(page.locator('.harness-card.kind-agent')).toHaveCount(1);
  await page.getByRole('button', { name: 'Save & test', exact: true }).click();
  await expect(await chat(page, 'Please use tool to answer')).toContainText('MCP lookup', { timeout: 30000 });
  await expect(page.locator('.trace-meta')).toContainText('succeeded');
});

test('an MCP action step validates its JSON arguments and renders structured results', async ({ page }) => {
  await newBlankWorkflow(page, `Browser action ${tag}`);
  await page.getByRole('button', { name: 'Add MCP action', exact: true }).click();
  await page.locator('.harness-card.kind-tool').dblclick();
  const modal = page.locator('.modal');
  await modal.getByLabel('Action MCP connection').selectOption({ label: connectionName });
  await modal.getByLabel('Action tool', { exact: true }).selectOption('calculate');
  await modal.getByLabel('Tool arguments JSON').fill('{"a":');
  await expect(modal.getByText('Enter a JSON object.', { exact: true })).toBeVisible();
  await modal.getByLabel('Tool arguments JSON').fill('{"a": 7, "b": 5}');
  await modal.getByRole('button', { name: 'Done' }).click();
  await page.locator('.harness-card.kind-finish').dblclick();
  await page.locator('.modal').getByLabel('Final response template').fill('Total: {{last.sum}}');
  await page.locator('.modal').getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Save & test', exact: true }).click();
  await expect(await chat(page, 'Run the calculation')).toContainText('Total: 12', { timeout: 30000 });
});

test('knowledge bases are created from the top bar, index uploads and answer searches', async ({ page }) => {
  await navButton(page, 'Knowledge').click();
  await page.locator('.topbar button[aria-label="New knowledge base"]').click();
  const name = `Browser knowledge ${tag}`;
  await page.getByLabel('Knowledge base name').fill(name);
  await page.getByLabel('Embedding provider').selectOption(providerId);
  await page.getByRole('button', { name: /save knowledge base/i }).click();
  await expect(page.locator('.kb-files-title h3')).toHaveText(name, { timeout: 15000 });
  await expect(page.locator('.kb-card.active', { hasText: name })).toBeVisible();
  await page.locator('.kb-workspace input[type=file]').setInputFiles({
    name: 'browser-handbook.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      'The Juniper project has four release stages: design, build, test, and release. Every stage has an owner.',
    ),
  });
  await expect(page.locator('.kb-file', { hasText: 'browser-handbook' }).locator('small')).toContainText(
    'passages',
    {
      timeout: 40000,
    },
  );
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByLabel('Search knowledge').fill('Juniper release stages');
  await page.locator('.modal').getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.knowledge-results')).toContainText('four release stages', { timeout: 20000 });
});

test('knowledge starter uploads a document inline and creates a grounded workflow', async ({ page }) => {
  await navButton(page, 'Workflows').click();
  await page.getByRole('button', { name: 'Create workflow', exact: true }).first().click();
  const starter = page.getByRole('dialog', { name: 'Start a workflow' });
  await starter.getByRole('button', { name: /Knowledge research/ }).click();
  await starter.getByRole('button', { name: 'Connect resources' }).click();
  await selectProvider(page, starter);
  await starter.getByRole('button', { name: 'Create knowledge base', exact: true }).click();
  const kbDialog = page.getByRole('dialog', { name: 'Create a knowledge base' });
  await kbDialog.getByLabel('Knowledge base name').fill(`Starter handbook ${tag}`);
  await kbDialog.getByLabel('Embedding provider').selectOption(providerId);
  await kbDialog.getByRole('button', { name: /save knowledge base/i }).click();
  await expect(kbDialog).not.toBeVisible();
  await starter.getByLabel('Upload workflow knowledge').setInputFiles({
    name: 'starter-guide.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('The Larch research guide requires five independent citations in every report.'),
  });
  await expect(starter.locator('.knowledge-readiness')).toContainText('ready', { timeout: 40000 });
  await starter.getByRole('button', { name: 'Open canvas' }).click();
  await expect(page.locator('.harness-card.kind-knowledge')).toBeVisible();
  await page.getByRole('button', { name: 'Save & test', exact: true }).click();
  await expect(await chat(page, 'What does the Larch research guide require?')).toContainText(
    'five independent citations',
    { timeout: 30000 },
  );
});

test('skills created on the Skills page are attached to an agent and loaded when relevant', async ({
  page,
}) => {
  await navButton(page, 'Skills').click();
  for (const [name, when, how] of [
    [`Incident triage ${tag}`, 'Use when someone reports an outage.', 'TRIAGE-STEPS: classify severity.'],
    [`Release notes ${tag}`, 'Use when asked to write release notes.', 'RELEASE-FORMAT: headline, bullets.'],
  ]) {
    await page
      .getByRole('button', { name: /new skill/i })
      .first()
      .click();
    await page.getByLabel('Skill name').fill(name);
    await page.getByLabel('Skill description').fill(when);
    await page.getByLabel('Skill instructions').fill(how);
    await page.getByRole('button', { name: /save skill/i }).click();
    await expect(page.locator('.skill-card', { hasText: name })).toBeVisible();
  }
  const name = `Skilled helper ${tag}`;
  await api(page.request, '/workflows', 'POST', {
    name,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'helper' },
      {
        id: 'helper',
        name: 'Helper',
        type: 'agent',
        prompt: '{{input}}',
        next: 'finish',
        config: { name: 'Helper', providerId, systemPrompt: 'Help the team.' },
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}' },
    ],
  });
  await page.reload();
  await navButton(page, 'Workflows').click();
  await page
    .locator('.workflow-card')
    .filter({ has: page.locator('.card-name', { hasText: name }) })
    .getByRole('button', { name: /open/i })
    .click();
  await page.locator('.harness-card.kind-agent').dblclick();
  await page.getByLabel(`Skill Incident triage ${tag}`).check();
  await page.getByLabel(`Skill Release notes ${tag}`).check();
  await page.locator('.modal').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.harness-card.kind-agent')).toContainText('2 skills');
  await page.getByRole('button', { name: 'Save & test', exact: true }).click();
  const answer = await chat(page, `Please use your skill: release notes ${tag} for version 2`);
  await expect(answer).toContainText('RELEASE-FORMAT', { timeout: 30000 });
  await expect(page.locator('.trace-panel')).toContainText(`Skill: Release notes ${tag}`);
  await expect(page.locator('.trace-panel')).not.toContainText(`Skill: Incident triage ${tag}`);
});

test('mobile navigation and profile remain usable without horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await navButton(page, 'Settings').click();
  await page.getByRole('button', { name: 'My profile', exact: true }).click();
  await expect(page.getByLabel('Profile name')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
});

test('an embedded chat created in the studio works without a studio login', async ({ page, browser }) => {
  await ensureToolFlow(page);
  await navButton(page, 'Integrations').click();
  await page.getByRole('button', { name: /Embedded chat/ }).click();
  await page.getByRole('button', { name: 'Create embed', exact: true }).click();
  await page.getByLabel('Integration name').fill(`Browser embed ${tag}`);
  const parentOrigin = process.env.TEST_FIXTURE_URL ?? 'http://localhost:19090';
  await page.getByLabel('Allowed embed origins').fill(parentOrigin);
  const options = await page.getByLabel('Integration target').locator('option').allTextContents();
  await page
    .getByLabel('Integration target')
    .selectOption({ label: options.find((o) => o.includes(toolFlow))! });
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
    await frame.getByLabel('Embed message', { exact: true }).fill('Hello without a studio session');
    await frame.getByRole('button', { name: 'Send embed message' }).click();
    await expect(frame.locator('.embed-bubble.assistant')).not.toBeEmpty({ timeout: 30000 });
    await expect(frame.locator('nav')).toHaveCount(0);
    await expect(frame.locator('.trace-panel')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('workspace admin adds a teammate who can open and edit shared workflows', async ({ page, browser }) => {
  await ensureToolFlow(page);
  await navButton(page, 'Settings').click();
  await page.getByRole('button', { name: 'Team & workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Add teammate', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a teammate' });
  const email = `browser-teammate-${tag}@openharness.test`;
  await dialog.getByLabel('New account name').fill('Browser teammate');
  await dialog.getByLabel('New account email').fill(email);
  await dialog.getByLabel('New account password').fill('Browser-teammate-password-42');
  await dialog.getByRole('button', { name: 'Create teammate' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: email })).toBeVisible();
  const context = await browser.newContext();
  try {
    const teammate = await context.newPage();
    await teammate.goto(base);
    await teammate.getByLabel('Email address').fill(email);
    await teammate.getByLabel('Password', { exact: true }).fill('Browser-teammate-password-42');
    await teammate.getByRole('button', { name: 'Sign in', exact: true }).click();
    const shared = teammate
      .locator('.workflow-card')
      .filter({ has: teammate.locator('.card-name', { hasText: toolFlow }) });
    await shared.getByRole('button', { name: /open/i }).click();
    await teammate.locator('.harness-card.kind-agent').dblclick();
    await teammate.locator('.modal').getByLabel('Component name').fill('Shared tool assistant');
    await teammate.locator('.modal').getByRole('button', { name: 'Done' }).click();
    await teammate.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(teammate.getByRole('dialog', { name: 'Workflow editor' })).toHaveCount(0);
    await navButton(teammate, 'Settings').click();
    await expect(teammate.getByRole('button', { name: 'Team & workspace', exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a webhook created in the studio runs a workflow through its scoped secret', async ({
  page,
  request,
}) => {
  await ensureToolFlow(page);
  await navButton(page, 'Integrations').click();
  await page.getByRole('button', { name: /^Webhook/ }).click();
  await page.getByRole('button', { name: 'Create webhook', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a webhook' });
  await dialog.getByLabel('Webhook name').fill(`Browser event ${tag}`);
  const options = await dialog.getByLabel('Webhook target').locator('option').allTextContents();
  await dialog
    .getByLabel('Webhook target')
    .selectOption({ label: options.find((n) => n.includes(toolFlow))! });
  await dialog.getByLabel('Webhook input field').fill('event.message');
  await dialog.getByRole('button', { name: 'Create webhook', exact: true }).click();
  const ready = page.getByRole('dialog', { name: 'Webhook ready' });
  const url = await ready.locator('code').textContent();
  const secret = await ready.locator('.secret-value').textContent();
  const auth = { Authorization: `Bearer ${secret}` };
  const response = await request.post(url!, {
    headers: auth,
    data: { event: { message: 'Please use tool from webhook' } },
  });
  expect(response.status()).toBe(202);
  const run = await response.json();
  await expect
    .poll(async () => (await (await request.get(`${url}/runs/${run.id}`, { headers: auth })).json()).status, {
      timeout: 30000,
    })
    .toBe('succeeded');
  const result = await (await request.get(`${url}/runs/${run.id}`, { headers: auth })).json();
  expect(result.output).toContain('MCP lookup');
  expect(result.events).toBeUndefined();
});

test('workflow settings set a knowledge workspace and learning, agents allow sub-agents, and answers take feedback', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const kb = await api(page.request, '/knowledge', 'POST', { name: `Browser workspace ${tag}`, providerId });
  await page.reload();
  await expect(page.locator('.sidebar nav')).toBeVisible();
  const name = `Browser learner ${tag}`;
  await newBlankWorkflow(page, name);
  await page.getByRole('button', { name: 'Add AI agent', exact: true }).click();
  const agent = page.locator('.harness-card.kind-agent');
  await agent.dblclick();
  const modal = page.locator('.modal');
  await selectProvider(page, modal);
  await modal.getByLabel('Can start sub-agents').check();
  await modal.getByLabel('Sub-agents per run').fill('3');
  await modal.getByRole('button', { name: 'Done' }).click();
  await page.locator('.workflow-header').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Knowledge workspace').selectOption(kb.id);
  await page.getByLabel('Learn from experience').check();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save & test', exact: true }).click();
  const saved = (await api(page.request, '/workflows')).find((w: any) => w.name === name);
  expect(saved.workspace.knowledgeBaseId).toBe(kb.id);
  expect(saved.experience.enabled).toBe(true);
  const node = saved.nodes.find((n: any) => n.type === 'agent');
  expect(node.config.delegation).toEqual({ enabled: true, maxAgents: 3 });

  await expect(await chat(page, 'Summarize the browser test plan')).toContainText('Completed:', {
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Bad answer' }).last().click();
  await page.getByLabel('What should change').fill('Shorter, please');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.feedback-bar.given').last()).toHaveText('Feedback saved');
  const runs = await api(page.request, '/runs');
  const rated = runs.find((r: any) => r.workflowId === saved.id);
  await expect
    .poll(async () => (await api(page.request, `/runs/${rated.id}`)).reflection?.status, { timeout: 30000 })
    .toBe('done');
  expect((await api(page.request, `/runs/${rated.id}`)).feedback.comment).toBe('Shorter, please');
  expect(errors).toEqual([]);
});

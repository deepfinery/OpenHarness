import { readFileSync } from 'node:fs';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// Toolbox items are dragged with pointer events, because Safari never delivers the HTML5 drop on the canvas.
// This spec also runs in WebKit (see playwright.config.ts), with a real mouse rather than synthetic drag events.
const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const admin = { email: 'admin@openharness.test', password: 'Integration-test-password-42' };
const headers = { Origin: base };

async function api(request: APIRequestContext, path: string, method = 'GET', data?: unknown) {
  const response = await request.fetch(`/api${path}`, { method, headers, data });
  expect(response.ok(), `${method} ${path} → ${response.status()} ${await response.text()}`).toBeTruthy();
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
async function signIn(request: APIRequestContext) {
  const status = await (await request.get('/api/auth/status')).json();
  if (!status.needsSetup) return api(request, '/auth/login', 'POST', admin);
  const setupToken =
    process.env.SETUP_TOKEN ??
    readFileSync('.env', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('SETUP_TOKEN='))
      ?.slice('SETUP_TOKEN='.length)
      .trim();
  await api(request, '/auth/setup', 'POST', { ...admin, name: 'Test Administrator', setupToken });
}
async function dragTo(page: Page, from: string, to: { x: number; y: number }) {
  // The toolbox scrolls when a workspace has many connections and knowledge bases.
  await page.locator(from).scrollIntoViewIfNeeded();
  const box = (await page.locator(from).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 10, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
}

test('a knowledge base dragged onto an existing agent is bound to it and saved', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const tag = `${test.info().project.name}-${Date.now().toString(36)}`;
  await signIn(page.request);
  const provider = await api(page.request, '/providers', 'POST', {
    name: `Drag model ${tag}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
    embeddingModel: 'test-embedding',
  });
  const kb = await api(page.request, '/knowledge', 'POST', {
    name: `Drag notes ${tag}`,
    providerId: provider.id,
  });
  const workflow = await api(page.request, '/workflows', 'POST', {
    name: `Drag flow ${tag}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'assistant', position: { x: 50, y: 140 } },
      {
        id: 'assistant',
        name: 'Assistant',
        type: 'agent',
        prompt: '{{input}}',
        next: 'finish',
        position: { x: 340, y: 110 },
        config: { name: 'Assistant', providerId: provider.id, systemPrompt: 'Answer.' },
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}', position: { x: 770, y: 140 } },
    ],
  });
  await page.goto('/workflows');
  await page
    .locator('.workflow-card')
    .filter({ has: page.locator('.card-name', { hasText: workflow.name }) })
    .getByRole('button', { name: /open/i })
    .click();
  const agent = page.locator('.harness-card.kind-agent');
  await expect(agent).toBeVisible();
  const item = `button[aria-label="Add ${kb.name}"]`;
  const knowledge = page.locator('.harness-card.kind-knowledge');

  // Released outside the canvas: nothing is added.
  const canvas = (await page.locator('.flow-canvas').boundingBox())!;
  await dragTo(page, item, { x: canvas.x - 100, y: canvas.y + 300 });
  await expect(page.locator('.drag-ghost')).toContainText(kb.name);
  await page.mouse.up();
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await expect(knowledge).toHaveCount(0);

  // Onto the agent: the card is highlighted while hovering, and the knowledge base is attached on release.
  const target = (await agent.boundingBox())!;
  await dragTo(page, item, { x: target.x + target.width / 2, y: target.y + target.height / 2 });
  await expect(page.locator('.harness-card.kind-agent.drop-target')).toHaveCount(1);
  await expect(page.locator('.drag-ghost')).toContainText('Attach to this agent');
  await page.mouse.up();
  await expect(knowledge).toHaveCount(1);
  await expect(page.locator('.harness-card.kind-agent.drop-target')).toHaveCount(0);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workflow editor' })).toHaveCount(0);
  const saved = await api(page.request, `/workflows/${workflow.id}`);
  const resource = saved.resources.find((r: any) => r.type === 'knowledge');
  expect(resource.knowledgeBaseId).toBe(kb.id);
  expect(saved.bindings).toEqual([{ agentNodeId: 'assistant', resourceId: resource.id }]);
  expect(errors).toEqual([]);
});

test('an MCP server whose tools were never discovered gets them when it is dropped onto an agent', async ({
  page,
}) => {
  const tag = `${test.info().project.name}-${Date.now().toString(36)}`;
  await signIn(page.request);
  const provider = await api(page.request, '/providers', 'POST', {
    name: `Fresh model ${tag}`,
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  // Added but never discovered, so the studio has no tool list for it yet.
  const server = await api(page.request, '/connections', 'POST', {
    name: `Fresh server ${tag}`,
    url: 'http://fixtures:9090/mcp',
  });
  const workflow = await api(page.request, '/workflows', 'POST', {
    name: `Fresh flow ${tag}`,
    startAt: 'start',
    nodes: [
      { id: 'start', name: 'Start', type: 'start', next: 'assistant', position: { x: 50, y: 140 } },
      {
        id: 'assistant',
        name: 'Assistant',
        type: 'agent',
        prompt: '{{input}}',
        next: 'finish',
        position: { x: 340, y: 110 },
        config: { name: 'Assistant', providerId: provider.id, systemPrompt: 'Answer.' },
      },
      { id: 'finish', name: 'Finish', type: 'finish', template: '{{last}}', position: { x: 770, y: 140 } },
    ],
  });
  await page.goto('/workflows');
  await page
    .locator('.workflow-card')
    .filter({ has: page.locator('.card-name', { hasText: workflow.name }) })
    .getByRole('button', { name: /open/i })
    .click();
  const agent = page.locator('.harness-card.kind-agent');
  await expect(agent).toBeVisible();
  const target = (await agent.boundingBox())!;
  await dragTo(page, `button[aria-label="Add ${server.name}"]`, {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  });
  await page.mouse.up();
  await expect(page.locator('.harness-card.kind-mcp', { hasText: server.name })).toContainText('5 tools');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Workflow editor' })).toHaveCount(0);
  const saved = await api(page.request, `/workflows/${workflow.id}`);
  expect(saved.resources[0].tools.length).toBeGreaterThan(0);
  expect(saved.bindings).toEqual([{ agentNodeId: 'assistant', resourceId: saved.resources[0].id }]);
});

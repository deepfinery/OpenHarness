import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

// Late in the evening in the Americas, UTC is already tomorrow. The Playground must send the browser's
// zone so "today" in a question means the viewer's calendar day, and the trace must show that clock.
test.use({ timezoneId: 'America/New_York' });

const base = process.env.TEST_BASE_URL ?? 'http://localhost:8088';
const password = 'Integration-test-password-42';
function setupToken() {
  if (process.env.SETUP_TOKEN) return process.env.SETUP_TOKEN;
  const line = readFileSync('.env', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('SETUP_TOKEN='));
  return line?.slice('SETUP_TOKEN='.length).trim() ?? '';
}
async function workspace(page: Page, label: string) {
  const api = async (path: string, data?: unknown) => {
    const r = await page.request.fetch('/api' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: base },
      data,
    });
    expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
    const text = await r.text();
    return text ? JSON.parse(text) : undefined;
  };
  const admin = { email: 'admin@openharness.test', password };
  if ((await api('/auth/status')).needsSetup)
    await api('/auth/setup', { ...admin, name: 'Test administrator', setupToken: setupToken() });
  else await api('/auth/login', admin);
  const credentials = { email: `${label}-${Date.now()}@openharness.test`, password };
  await api('/users', { ...credentials, name: 'Browser clock', workspace: 'new' });
  await api('/auth/login', credentials);
  return api;
}
async function send(page: Page, message: string) {
  const chat = page.waitForResponse((r) => r.url().endsWith('/api/chat') && r.request().method() === 'POST');
  await page.getByLabel('Message your agent').fill(message);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await chat;
  return { body: response.request().postDataJSON(), runId: (await response.json()).runId as string };
}
const newYorkDate = (instant: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));

test('the Playground sends the browser timezone and the trace shows the clock in that zone', async ({
  page,
}) => {
  const api = await workspace(page, 'clock-browser');
  const provider = await api('/providers', {
    name: 'Browser clock model',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-clock',
  });
  const agent = await api('/agents', {
    name: 'Clock agent',
    providerId: provider.id,
    systemPrompt: 'Research.',
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/playground');
  await page.getByLabel('Playground agent or harness').selectOption(`agent:${agent.id}`);
  const { body, runId } = await send(page, 'clock-probe: what happened today to Apple stock');
  expect(body.timezone).toBe('America/New_York');
  const answer = page.locator('.chat-message.assistant .markdown').last();
  await expect(answer).toContainText('(America/New_York)');
  await expect(answer).not.toContainText('No timezone was configured');
  await expect(page.locator('.trace-event.runtime_clock')).toContainText('(America/New_York)');
  const run = await api(`/runs/${runId}`);
  expect(run.timezone).toBe('America/New_York');
  const clock = run.events.find((e: any) => e.type === 'runtime_clock').data;
  expect(clock.timezone).toBe('America/New_York');
  expect(clock.fallback).toBe(false);
  // The local date is New York's calendar day for the reference instant, even when UTC has moved on.
  expect(clock.localTime.slice(0, 10)).toBe(newYorkDate(clock.referenceTime));
  expect(errors).toEqual([]);
});

test('a skill loaded from the Playground is followed and recorded in the trace', async ({ page }) => {
  const api = await workspace(page, 'skill-browser');
  const provider = await api('/providers', {
    name: 'Browser skill model',
    kind: 'openai-compatible',
    baseUrl: 'http://fixtures:9090/v1',
    model: 'test-chat',
  });
  const skill = await api('/skills', {
    name: 'Session date report',
    description: 'Use when someone asks what happened today to a stock.',
    instructions:
      'State the completed session date in the configured timezone before any price. End with: Verify before trading.',
  });
  const agent = await api('/agents', {
    name: 'Skill agent',
    providerId: provider.id,
    systemPrompt: 'Follow your skills.',
    skillIds: [skill.id],
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/playground');
  await page.getByLabel('Playground agent or harness').selectOption(`agent:${agent.id}`);
  const { body, runId } = await send(page, 'use your skill: what happened today to Apple stock');
  expect(body.timezone).toBe('America/New_York');
  const answer = page.locator('.chat-message.assistant .markdown').last();
  await expect(answer).toContainText('Loaded skill "Session date report"');
  await expect(answer).toContainText('Verify before trading.');
  await expect(page.locator('.trace-event.skill_loaded')).toContainText('Skill: Session date report');
  await expect(page.locator('.trace-event.runtime_clock')).toContainText('(America/New_York)');
  const run = await api(`/runs/${runId}`);
  expect(
    run.events.some((e: any) => e.type === 'skill_loaded' && e.data.skill === 'Session date report'),
  ).toBe(true);
  expect(run.events.find((e: any) => e.type === 'runtime_clock').data.timezone).toBe('America/New_York');
  expect(errors).toEqual([]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  UNLIMITED,
  deadlineSignal,
  effectiveLimit,
  limitText,
  unlimited,
  withDeadline,
} from '../../packages/core/src/limits.js';
import { budgetedAgent, effortPresets } from '../../packages/core/src/patterns.js';
import { agentSchema, workflowSchema } from '../../packages/core/src/schema.js';

// Modules behind the installation config need its required settings.
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'unit-test-setup-token'.repeat(3);
const { guardrailPolicySchema } = await import('../../packages/core/src/guardrailPolicy.js');
const { toolCallTimeoutMs } = await import('../../packages/core/src/toolOutcome.js');

test('a limit of 0 means no limit', () => {
  assert.equal(unlimited(0), true);
  assert.equal(unlimited(UNLIMITED), true);
  assert.equal(unlimited(undefined), true);
  assert.equal(unlimited(12), false);
  assert.equal(effectiveLimit(0, 12), UNLIMITED);
  assert.equal(effectiveLimit(undefined, 12), 12);
  assert.equal(effectiveLimit(40, 12), 40);
  assert.equal(limitText(0, 'turns'), 'unlimited');
  assert.equal(limitText(120000, 'tokens'), '120,000 tokens');
});

test('deadlines longer than a JavaScript timer allows are still armed, and no deadline means no timer', async () => {
  const signal = withDeadline(new AbortController().signal, 0);
  assert.equal(signal.aborted, false);
  const month = deadlineSignal(30 * 86400 * 1000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(month.aborted, false, 'a 30-day deadline did not fire at once');
  const soon = deadlineSignal(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(soon.aborted, true);
});

test('fixed-effort agents with 0 limits run unlimited; auto effort keeps its presets', () => {
  const stored = agentSchema.parse({
    name: 'Long job',
    providerId: randomUUID(),
    systemPrompt: 'Work through every ticker.',
    pattern: 'loop',
    effort: 'high',
    maxTurns: 0,
    timeoutSeconds: 0,
    tokenBudget: 0,
    patternConfig: { iterations: 0 },
  });
  const agent = budgetedAgent(stored, 'Analyse the S&P 500');
  assert.equal(agent.maxTurns, UNLIMITED);
  assert.equal(agent.tokenBudget, UNLIMITED);
  assert.equal(agent.patternConfig.iterations, UNLIMITED);
  assert.equal(agent.timeoutSeconds, 0);
  // Omitted tokenBudget still falls back to the effort preset; a fixed finite limit is kept.
  const preset = budgetedAgent(agentSchema.parse({ ...stored, tokenBudget: undefined, maxTurns: 40 }), 'x');
  assert.equal(preset.tokenBudget, effortPresets.high.tokenBudget);
  assert.equal(preset.maxTurns, 40);
  const auto = budgetedAgent(agentSchema.parse({ ...stored, effort: 'auto' }), 'short question');
  assert.equal(auto.tokenBudget, effortPresets.medium.tokenBudget);
  assert.equal(auto.maxTurns, effortPresets.medium.maxTurns);
});

test('harness step budgets, guardrail latency budgets and tool timeouts accept long jobs', () => {
  const harness = {
    name: 'Cycle',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'finish' },
      { id: 'finish', type: 'finish', name: 'Finish' },
    ],
  };
  assert.equal(workflowSchema.parse({ ...harness, maxSteps: 0 }).maxSteps, 0);
  assert.equal(workflowSchema.parse({ ...harness, maxSteps: 50_000 }).maxSteps, 50_000);
  assert.equal(workflowSchema.safeParse({ ...harness, maxSteps: -1 }).success, false);
  assert.equal(guardrailPolicySchema.parse({ name: 'p', latencyBudgetMs: 0 }).latencyBudgetMs, 0);
  // A tool that says it needs six hours is waited for, not cut off at one.
  assert.equal(toolCallTimeoutMs({ timeout_seconds: 6 * 3600 }), 6 * 3600 * 1000 + 15_000);
});

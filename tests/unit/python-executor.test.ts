import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentSchema, workflowSchema } from '../../packages/core/src/schema.js';
import { PYTHON_TOOL, pythonToolDefinition, summarizeJob } from '../../packages/core/src/pythonTool.js';
import { validateToolArguments } from '../../packages/core/src/toolValidation.js';

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'unit-test-setup-token'.repeat(3);
process.env.EXECUTOR_MAX_TIMEOUT_SECONDS = '7200';
const { jobTimeoutSeconds, executorUnavailableReason } = await import('../../packages/core/src/codeJobs.js');

test('the Python tool takes a script with parameters or a parameter list, and rejects anything else', () => {
  assert.equal(pythonToolDefinition.name, PYTHON_TOOL);
  // The validator answers null for valid arguments and a message otherwise.
  assert.equal(validateToolArguments(pythonToolDefinition.inputSchema, { code: 'print(1)' }), null);
  assert.equal(
    validateToolArguments(pythonToolDefinition.inputSchema, {
      code: 'import oh',
      params_list: [{ x: 1 }, { x: 2 }],
      timeout_seconds: 120,
    }),
    null,
  );
  assert.ok(validateToolArguments(pythonToolDefinition.inputSchema, { params: {} }), 'code is required');
  assert.ok(validateToolArguments(pythonToolDefinition.inputSchema, { code: 5 }), 'code must be a string');
});

test('job outcomes are summarised with bounded output for the model', () => {
  const summary = summarizeJob({
    id: 'job-1',
    status: 'succeeded',
    exitCode: 0,
    stdout: 'x'.repeat(10_000),
    stderr: '',
    result: { rows: 3 },
    durationMs: 1200,
  });
  assert.equal(summary.status, 'succeeded');
  assert.deepEqual(summary.result, { rows: 3 });
  assert.ok(summary.stdout.length < 6200);
  assert.match(summary.stdout, /4000 earlier characters omitted/);
  assert.equal('error' in summary, false);
  const failed = summarizeJob({
    id: 'job-2',
    status: 'failed',
    exitCode: 1,
    error: 'boom',
    stdout: '',
    stderr: 'Traceback',
  });
  assert.equal(failed.error, 'boom');
  assert.equal(failed.stderr, 'Traceback');
});

test('job timeouts fall back to the installation default and respect its maximum', () => {
  assert.equal(jobTimeoutSeconds(undefined), 600);
  assert.equal(jobTimeoutSeconds(0), 600);
  assert.equal(jobTimeoutSeconds(90), 90);
  assert.equal(jobTimeoutSeconds(999_999), 7200);
  assert.match(executorUnavailableReason() ?? '', /EXECUTOR_BACKEND/);
});

test('agents can enable Python and harnesses can hold Python steps', () => {
  const agent = agentSchema.parse({
    name: 'Quant',
    providerId: randomUUID(),
    systemPrompt: 'Analyse.',
    codeExecution: { enabled: true, requireApproval: true },
  });
  assert.deepEqual(agent.codeExecution, {
    enabled: true,
    timeoutSeconds: 0,
    requireApproval: true,
    secrets: [],
  });
  assert.equal(agentSchema.parse({ ...agent, codeExecution: undefined }).codeExecution, undefined);
  const harness = workflowSchema.parse({
    name: 'ETL',
    startAt: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', next: 'load' },
      {
        id: 'load',
        type: 'code',
        name: 'Load',
        code: 'import oh',
        params: { ticker: '{{payload.ticker}}' },
        next: 'finish',
      },
      { id: 'finish', type: 'finish', name: 'Finish' },
    ],
  });
  const step = harness.nodes.find((n) => n.id === 'load');
  assert.equal(step?.type, 'code');
  if (step?.type === 'code') {
    assert.equal(step.timeoutSeconds, 0);
    assert.deepEqual(step.params, { ticker: '{{payload.ticker}}' });
  }
  assert.equal(
    workflowSchema.safeParse({
      ...harness,
      nodes: [
        harness.nodes[0],
        { id: 'load', type: 'code', name: 'Load', code: '', next: 'finish' },
        harness.nodes[2],
      ],
    }).success,
    false,
    'empty code is rejected',
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const {
  classifyToolFailure,
  toolCallTimeoutMs,
  uncertainToolResult,
  callSignature,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
} = await import('../../packages/core/src/toolOutcome.js');
const { AmbiguousToolCall } = await import('../../packages/core/src/executionRecovery.js');

test('a failed tool call is sorted by what is known about its effect', () => {
  const unknown = [
    new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
    new McpError(ErrorCode.ConnectionClosed, 'Connection closed'),
    new McpError(ErrorCode.InternalError, 'Internal error'),
    new McpError(-32013, 'device did not answer run_command in time'),
    new McpError(-32014, 'device reconnected while the call was in flight'),
    new AmbiguousToolCall('An external action has an unknown outcome.'),
    new Error('socket hang up'),
  ];
  for (const error of unknown) assert.equal(classifyToolFailure(error).outcome, 'unknown', error.message);
  const notExecuted = [
    new McpError(-32010, 'device offline'),
    new McpError(-32011, 'tool not allowed'),
    new McpError(-32012, 'approval denied for run_command'),
    new McpError(ErrorCode.InvalidParams, 'bad arguments'),
    new McpError(ErrorCode.MethodNotFound, 'no such tool'),
    new Error('Not connected'),
  ];
  for (const error of notExecuted)
    assert.equal(classifyToolFailure(error).outcome, 'not_executed', error.message);
  assert.equal(classifyToolFailure('plain string').message, 'plain string');
  // The durable-call journal wraps the real error; the classification and message follow the cause.
  const wrappedTimeout = new AmbiguousToolCall('The external action was interrupted.', {
    cause: new McpError(-32013, 'device did not answer run_command in time'),
  });
  assert.deepEqual(classifyToolFailure(wrappedTimeout), {
    outcome: 'unknown',
    message: 'MCP error -32013: device did not answer run_command in time',
  });
  const wrappedOffline = new AmbiguousToolCall('The external action was interrupted.', {
    cause: new McpError(-32010, 'device offline'),
  });
  assert.equal(
    classifyToolFailure(wrappedOffline).outcome,
    'not_executed',
    'the server said it did not run it',
  );
  assert.equal(classifyToolFailure(new AmbiguousToolCall('journal only')).outcome, 'unknown');
});

test('an uncertain result tells the model to verify and never to repeat the call', () => {
  const text = uncertainToolResult('run_command', {
    outcome: 'unknown',
    message: 'MCP error -32001: Request timed out',
  });
  assert.match(text, /^Outcome unknown: MCP error -32001: Request timed out/);
  assert.match(text, /may or may not have taken effect/);
  assert.match(text, /read-only tool first/);
  assert.match(text, /identical call is refused for the rest of this run/);
});

test('the runtime waits for a tool at least as long as the tool itself will', () => {
  assert.equal(
    DEFAULT_TOOL_CALL_TIMEOUT_MS,
    150_000,
    'longer than a connector (60 s) or gateway (120 s) default',
  );
  assert.equal(toolCallTimeoutMs({}), 150_000);
  assert.equal(toolCallTimeoutMs(undefined), 150_000);
  assert.equal(toolCallTimeoutMs({ timeout_seconds: 'soon' }), 150_000);
  assert.equal(toolCallTimeoutMs({ timeout_seconds: 5 }), 150_000, 'never shorter than the default');
  assert.equal(toolCallTimeoutMs({ timeout_seconds: 600 }), 615_000, 'the tool timeout plus a margin');
  assert.equal(
    toolCallTimeoutMs({ timeout_seconds: 99_999 }),
    3_615_000,
    'capped at the connectors’ one-hour maximum',
  );
});

test('a call signature identifies the same tool with the same arguments', () => {
  assert.equal(
    callSignature('run_command', { argv: ['ls'] }),
    callSignature('run_command', { argv: ['ls'] }),
  );
  assert.notEqual(
    callSignature('run_command', { argv: ['ls'] }),
    callSignature('run_command', { argv: ['ls', '-a'] }),
  );
  assert.notEqual(
    callSignature('run_command', { argv: ['ls'] }),
    callSignature('read_file', { argv: ['ls'] }),
  );
  assert.equal(callSignature('system_info', undefined), 'system_info:{}');
});

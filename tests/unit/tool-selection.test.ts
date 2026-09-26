import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolSelection } from '../../packages/core/src/toolValidation.js';
const offered = [{ name: 'mcp_allowed', description: 'VM / run_command', inputSchema: {} }];
const call = (name: string) => ({ id: 'call', name, arguments: {} });

test('tool selection requires exact names from the current pass, including builtins', () => {
  assert.equal(validateToolSelection([call('mcp_allowed')], offered), undefined);
  for (const name of ['run_command', 'functions.run_command', 'memory_write', 'spawn_agents']) {
    const rejected = validateToolSelection([call('mcp_allowed'), call(name)], offered)!;
    assert.equal(rejected.reason, 'unavailable_tool');
    assert.deepEqual(rejected.unavailable, [name]);
    assert.match(rejected.feedback, /No calls in this batch ran/);
    assert.match(rejected.feedback, /mcp_allowed/);
  }
  assert.equal(validateToolSelection([call('mcp_allowed')], [])?.reason, 'unavailable_tool');
});

test('oversized batches are rejected before dispatch and diagnostics exclude arguments', () => {
  const calls = Array.from({ length: 21 }, () => ({
    ...call('mcp_allowed'),
    arguments: { secret: 'private payload' },
  }));
  assert.equal(validateToolSelection(calls.slice(0, 20), offered), undefined);
  const rejected = validateToolSelection(calls, offered)!;
  assert.equal(rejected.reason, 'too_many_calls');
  assert.ok(!JSON.stringify(rejected).includes('private payload'));
});

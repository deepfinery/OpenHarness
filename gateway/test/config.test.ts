import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolTimeouts, type GatewayConfig } from '../src/config.js';

test('a call may extend the default tool timeout, but never an operator override', () => {
  const timeoutFor = toolTimeouts({
    GATEWAY_TOOL_TIMEOUT_SECONDS: 120,
    GATEWAY_TOOL_TIMEOUTS: 'slow=1, gpu_remediate=900',
  } as GatewayConfig);
  assert.equal(timeoutFor('run_command'), 120_000, 'the default applies without a request');
  assert.equal(
    timeoutFor('run_command', 5),
    120_000,
    'a short request never shortens the wait below the default',
  );
  assert.equal(
    timeoutFor('run_command', 600),
    610_000,
    'a long request extends it, with a margin for the connector',
  );
  assert.equal(timeoutFor('run_command', 99_999), 3_610_000, 'capped at the connectors’ one-hour maximum');
  assert.equal(timeoutFor('run_command', Number.NaN), 120_000, 'a missing or unusable request falls back');
  assert.equal(timeoutFor('slow', 600), 1_000, 'an operator override is a cap');
  assert.equal(timeoutFor('gpu_remediate'), 900_000);
});

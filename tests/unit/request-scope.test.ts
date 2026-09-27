import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGreeting } from '../../packages/core/src/requestScope.js';

test('greetings cannot reactivate a previous objective, but substantive requests still run', () => {
  for (const input of ['hey', 'Hello!', 'hi there', ' Good morning. ']) assert.ok(isGreeting(input));
  for (const input of ['hey, continue the audit', 'hello world in Python', 'continue', 'scan vm4', ''])
    assert.equal(isGreeting(input), false);
});

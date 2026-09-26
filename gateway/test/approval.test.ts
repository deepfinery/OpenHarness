import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signApprovalCall } from '@openharness/connector-core';
import { studioApproval } from '../src/approval.js';
import { loadConfig } from '../src/config.js';
import { memoryStorage } from '../src/registry.js';
test('studio approvals bind the exact machine call and consume the grant once', async () => {
  const store = memoryStorage();
  const secret = 'approval-test-secret';
  const approval = studioApproval(secret, store.consumeApproval);
  const call = {
    deviceId: 'machine',
    tool: 'run_command',
    arguments: { argv: ['uname', '-a'] },
    callId: 'run:agent:1',
  };
  const request = {
    device_id: call.deviceId,
    tool: call.tool,
    arguments: call.arguments,
    identity: 'orchestrator',
    callId: call.callId,
    proof: signApprovalCall(secret, call),
  };
  assert.equal(await approval.decide({ ...request, arguments: { argv: ['changed'] } }), 'denied');
  assert.equal(await approval.decide({ ...request, device_id: 'other-machine' }), 'denied');
  assert.equal(
    await approval.decide({ ...request, proof: signApprovalCall(secret, call, Date.now() - 31000) }),
    'denied',
  );
  assert.equal(await approval.decide(request), 'approved');
  assert.equal(await approval.decide(request), 'denied');
  assert.equal(await approval.decide({ ...request, callId: 'another-call' }), 'denied');
});

test('approval configuration accepts an unused blank URL and refuses incomplete enforcing modes', () => {
  assert.equal(loadConfig({ GATEWAY_APPROVAL_URL: '' }).GATEWAY_APPROVAL_PROVIDER, 'noop');
  assert.throws(
    () => loadConfig({ GATEWAY_APPROVAL_PROVIDER: 'webhook', GATEWAY_APPROVAL_URL: '' }),
    /requires a URL/,
  );
  assert.throws(
    () => loadConfig({ GATEWAY_APPROVAL_PROVIDER: 'studio' }),
    /requires a shared administrator secret/,
  );
  assert.equal(
    loadConfig({
      GATEWAY_APPROVAL_PROVIDER: 'studio',
      GATEWAY_ADMIN_TOKEN: 'shared-secret',
      GATEWAY_APPROVAL_URL: '',
    }).GATEWAY_APPROVAL_PROVIDER,
    'studio',
  );
});

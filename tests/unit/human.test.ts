import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'human-test-setup-token'.repeat(3);
const { canAnswer, needsApproval, humanLinkToken, validHumanLink } =
  await import('../../packages/core/src/human.js');
const { humanSettingsSchema, workflowSchema } = await import('../../packages/core/src/schema.js');
import type { HumanRequest } from '../../packages/core/src/human.js';
test('risk approval defaults deny unknown risk, preserves explicit policies, and never grants tools', () => {
  const settings = humanSettingsSchema.parse({
    mode: 'when_risky',
    tools: { 'mcp.one.read': 'never', 'mcp.one.write': 'always' },
  });
  assert.equal(needsApproval(settings, 'mcp.one.unknown'), true);
  assert.equal(needsApproval(settings, 'mcp.one.safe', { readOnlyHint: true }), false);
  assert.equal(needsApproval(settings, 'mcp.one.safe', { readOnlyHint: true }, 0.9), true);
  assert.equal(needsApproval(settings, 'mcp.one.safe', { readOnlyHint: true, destructiveHint: true }), true);
  assert.equal(needsApproval(settings, 'mcp.one.read', { destructiveHint: true }), false);
  assert.equal(needsApproval(settings, 'mcp.one.write', { readOnlyHint: true }), true);
  assert.equal(needsApproval(undefined, 'mcp.one.unknown'), false);
});
test('approver rules and signed links bind to the request, workspace and expiration', () => {
  const r = {
    _id: 'request',
    ownerId: 'tenant',
    initiatedBy: 'owner',
    settings: humanSettingsSchema.parse({
      approvers: { admins: false, owner: true, userIds: ['c910f8d1-0fbe-4a04-8bf0-c25785e82ac7'] },
    }),
    expiresAt: new Date(Date.now() + 60000),
  } as HumanRequest;
  assert.equal(canAnswer(r, { id: 'owner', role: 'member' }), true);
  assert.equal(canAnswer(r, { id: 'unlisted', role: 'admin' }), false);
  const token = humanLinkToken(r);
  assert.equal(validHumanLink(r, token), true);
  assert.equal(validHumanLink({ ...r, ownerId: 'other' }, token), false);
  assert.equal(validHumanLink({ ...r, expiresAt: new Date(0) }, token), false);
  assert.equal(validHumanLink(r, 'x'), false);
});
test('review branches are checked for missing targets and reachability', () => {
  const valid = {
    name: 'Review',
    startAt: 'review',
    nodes: [
      { id: 'review', name: 'Review', type: 'review', onApprove: 'yes', onReject: 'no' },
      { id: 'yes', name: 'Yes', type: 'output', template: 'yes' },
      { id: 'no', name: 'No', type: 'output', template: 'no' },
    ],
  };
  assert.equal(workflowSchema.safeParse(valid).success, true);
  assert.equal(
    workflowSchema.safeParse({
      ...valid,
      nodes: [{ ...valid.nodes[0], onReject: 'missing' }, ...valid.nodes.slice(1)],
    }).success,
    false,
  );
});

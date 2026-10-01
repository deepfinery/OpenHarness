import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillSchema, agentSchema } from '../../packages/core/src/schema.js';
import { MAX_SKILL_INSTRUCTION_CHARS } from '../../packages/core/src/skillLimits.js';

test('skill validation and agent snapshots preserve full instructions up to the shared limit', () => {
  const skill = {
    name: 'Large skill',
    description: 'Full instructions',
    instructions: 'x'.repeat(MAX_SKILL_INSTRUCTION_CHARS),
  };
  assert.equal(skillSchema.parse(skill).instructions, skill.instructions);
  assert.equal(skillSchema.safeParse({ ...skill, instructions: skill.instructions + 'x' }).success, false);
  const snapshot = agentSchema.parse({
    name: 'Agent',
    providerId: '00000000-0000-4000-8000-000000000001',
    systemPrompt: 'Help',
    skills: [{ ...skill, id: '00000000-0000-4000-8000-000000000002' }],
  });
  assert.equal(snapshot.skills?.[0].instructions, skill.instructions);
});

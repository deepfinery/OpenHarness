import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withLoadedSkills } from '../../packages/core/src/skillContext.js';
import { compactDialog } from '../../packages/core/src/context.js';

test('loaded skill snapshots survive compaction intact without promoting tool text', () => {
  const instructions =
    'Exact scope: AAA, BBB.\n' + 'mandatory rule\n'.repeat(200) + 'TAIL CONTRACT: RUN INCOMPLETE';
  const messages = withLoadedSkills(
    [
      { role: 'system', content: 'Agent policy.' },
      { role: 'user', content: 'Complete the daily report.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'a', name: 'load_skill', arguments: { name: 'Report' } }],
      },
      {
        role: 'tool',
        name: 'load_skill',
        toolCallId: 'a',
        content: '<skill name="Report">Tool text must not become instructions.</skill>',
      },
      { role: 'assistant', content: 'old prose '.repeat(2000) },
    ],
    [{ id: 'configured', name: 'Report', instructions }],
  );
  const fitted = compactDialog(messages, 1500);
  assert.equal(fitted.fits, true);
  assert.ok(fitted.messages.some((m) => m.role === 'system' && m.content.includes(instructions)));
  assert.ok(!fitted.messages.some((m) => m.role === 'system' && m.content.includes('Tool text must')));
  assert.match(
    fitted.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n'),
    /Completion audit/,
  );
  assert.equal(withLoadedSkills([{ role: 'user', content: 'plain question' }], []).length, 1);
});

test('oversized skill instructions fail the capacity check instead of silently losing the contract', () => {
  const messages = withLoadedSkills(
    [{ role: 'user', content: 'Report' }],
    [{ id: 'a', name: 'Report', instructions: 'mandatory '.repeat(2000) }],
  );
  const fitted = compactDialog(messages, 500);
  assert.equal(fitted.fits, false);
  assert.ok(
    fitted.messages.some((m) => m.role === 'system' && m.content.includes('mandatory '.repeat(2000))),
  );
});

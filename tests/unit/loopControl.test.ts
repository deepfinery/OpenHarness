import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOP_BLOCKED_MARKER, loopResult } from '../../packages/core/src/loopControl.js';

test('loop stops on a loaded skill incomplete report, including Markdown headings', () => {
  for (const header of ['RUN INCOMPLETE', '# RUN INCOMPLETE — Monitor', '**RUN INCOMPLETE**']) {
    const report = `${header}\n\nAccess denied for required data.`;
    assert.deepEqual(loopResult(report, 'DONE', true), { status: 'blocked', content: report });
    assert.equal(loopResult(`${report}\nDONE`, 'DONE', true).status, 'blocked');
  }
});

test('loop respects explicit terminal blockers without a loaded skill', () => {
  assert.deepEqual(loopResult(`Access must be restored.\n${LOOP_BLOCKED_MARKER}`, 'DONE', false), {
    status: 'blocked',
    content: 'Access must be restored.',
  });
});

test('loop control requires standalone exact footers and ignores quoted incomplete headings', () => {
  for (const text of [
    'Almost DONE',
    'DONE\nMore work',
    '> RUN INCOMPLETE',
    'Example: RUN INCOMPLETE',
    'RUN INCOMPLETELY',
  ])
    assert.equal(loopResult(text, 'DONE', true).status, 'continue', text);
  assert.equal(loopResult('RUN INCOMPLETE', 'DONE', false).status, 'continue');
  assert.deepEqual(loopResult('Verified answer.\r\n FINISHED.+ \r\n', 'FINISHED.+', false), {
    status: 'done',
    content: 'Verified answer.',
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MACHINE_OPERATOR_PROMPT, OPENSHELL_OPERATOR_PROMPT } from '../../packages/core/src/starters.js';

process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);
process.env.SETUP_TOKEN ??= 'unit-test-setup-token'.repeat(3);
const { lessonsNote, recalledMemoryLine, REFLECTION_PROMPT } =
  await import('../../packages/core/src/experience.js');
const { workspaceNote } = await import('../../packages/core/src/workspace.js');

test('recalled memory is introduced as the past, with tool results winning over it', () => {
  const note = lessonsNote('- Lesson: check nvidia-smi first');
  assert.match(note, /Past experience from earlier runs/);
  assert.match(note, /describes the past, not the present/);
  assert.match(note, /Never report it as the current state/);
  assert.match(note, /verify it with this run's tools/);
  assert.match(note, /your tool results are correct/);
  assert.match(note, /say that it comes from an earlier run and when it was recorded/);
  // The recalled items stay inside the tag the runtime and the test model read.
  assert.match(note, /<lessons>\n- Lesson: check nvidia-smi first\n<\/lessons>$/);
});

test('each recalled lesson and experiment carries when it was recorded', () => {
  const createdAt = new Date('2026-09-28T22:40:12Z');
  const lesson = recalledMemoryLine({
    createdAt,
    meta: { lesson: 'Lesson: sweep all GPUs.', rating: 'down' },
  });
  assert.equal(lesson, '- Lesson: sweep all GPUs. (from negative feedback) [recorded 2026-09-28 22:40 UTC]');
  const experiment = recalledMemoryLine({
    createdAt,
    meta: {
      run_id: 'run-1',
      outcome: 'succeeded',
      input: 'is any LLM running on vm1?',
      result: 'All GPUs idle.',
    },
  });
  assert.match(
    experiment,
    /^- Previous experiment recorded 2026-09-28 22:40 UTC \(run run-1; succeeded; unreviewed\)/,
  );
  assert.match(experiment, /is any LLM running on vm1\?/);
  assert.match(
    experiment,
    /\n {2}Result at that time: All GPUs idle\.$/,
    'a past result is labeled as the past',
  );
  const reviewed = recalledMemoryLine(
    { createdAt, meta: { run_id: 'run-2', outcome: 'succeeded', input: 'x', result: 'y' } },
    { rating: 'up', comment: 'correct' } as never,
  );
  assert.match(reviewed, /\(run run-2; succeeded; approved: correct\)/);
  assert.match(recalledMemoryLine({ meta: { lesson: 'Lesson: z' } }), /\[recorded at an unknown time\]$/);
});

test('lessons are written about approach, and the test model still recognises the reflection prompt', () => {
  assert.ok(REFLECTION_PROMPT.startsWith('You turn one run of an AI agent into a lesson'));
  assert.match(REFLECTION_PROMPT, /Write about approach, not about state/);
});

test('notebook guidance treats volatile state as a dated snapshot', () => {
  assert.match(
    workspaceNote,
    /durable environment facts \(hardware, installed software, layout\) with the date observed/,
  );
  assert.match(
    workspaceNote,
    /volatile state such as running processes, usage or health is a dated snapshot/,
  );
  assert.match(workspaceNote, /never report an earlier answer or snapshot as the current state/);
  assert.match(workspaceNote, /When tool results disagree with a note, the tool results are correct/);
});

test('operator templates take the current state only from this request’s tool results', () => {
  for (const prompt of [MACHINE_OPERATOR_PROMPT, OPENSHELL_OPERATOR_PROMPT]) {
    assert.match(prompt, /only from tool results you get for this request/);
    assert.match(prompt, /your own earlier answers describe the past/);
    assert.match(prompt, /the tool results are correct/);
  }
});

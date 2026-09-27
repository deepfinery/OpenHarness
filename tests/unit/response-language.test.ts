import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responseLanguagePolicy, responseLanguageSource } from '../../packages/core/src/responseLanguage.js';
import { compactDialog } from '../../packages/core/src/context.js';
import { finalAnswerMessages } from '../../packages/core/src/finalAnswer.js';

test('compaction preserves original language wording at user priority, including explicit overrides', () => {
  for (const request of [
    'Analyze Nvidia stock and latest news, is it bulish or bearish?',
    'Erkläre die Ergebnisse.',
    'Explain these results in Japanese.',
  ]) {
    const source = responseLanguageSource(request);
    const result = compactDialog(
      [
        { role: 'system', content: responseLanguagePolicy },
        source,
        { role: 'assistant', content: 'Deutsche Quellen. '.repeat(4000) },
        { role: 'user', content: 'Revise your answer using this critique. '.repeat(1000) },
      ],
      500,
    );
    assert.ok(result.fits);
    assert.deepEqual(
      result.messages.find((m) => m.responseLanguageSource),
      source,
    );
    assert.equal(source.role, 'user');
    assert.ok(!result.messages.filter((m) => m.role === 'system').some((m) => m.content.includes(request)));
    const tooSmall = compactDialog(result.messages, 1);
    assert.equal(tooSmall.fits, false, 'do not silently discard language instructions to fit');
    assert.deepEqual(
      tooSmall.messages.find((m) => m.responseLanguageSource),
      source,
    );
  }
});

test('final synthesis keeps root language distinct from delegated task and foreign evidence', () => {
  const root = 'Explain the outlook in English.';
  const messages = finalAnswerMessages(
    'Research carefully.',
    'Prüfe diese Quellen.',
    [
      responseLanguageSource(root),
      { role: 'assistant', content: 'Die Ergebnisse sind positiv.' },
      { role: 'user', content: 'Summarize the delegated results.' },
    ],
    [],
    root,
  );
  assert.ok(messages[0].content.includes(responseLanguagePolicy));
  assert.deepEqual(
    messages.filter((m) => m.responseLanguageSource),
    [responseLanguageSource(root)],
  );
  assert.match(messages.at(-1)!.content, /Die Ergebnisse/);
  assert.doesNotMatch(messages.at(-1)!.content, /language reference only/);
});

test('large language references are bounded while retaining the opening and trailing constraints', () => {
  const source = responseLanguageSource(
    'Explain this report. ' + 'Background. '.repeat(10000) + ' Answer in English.',
  );
  assert.ok(source.content.length < 1300);
  assert.match(source.content, /Explain this report/);
  assert.match(source.content, /Answer in English/);
  assert.match(source.content, /context omitted/);
});

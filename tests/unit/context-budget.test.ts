import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactDialog, contextAllowance, dialogTokens } from '../../packages/core/src/context.js';
import type { ChatMessage } from '../../packages/core/src/llm.js';

test('oversized output settings cannot consume the context or the run budget', () => {
  for (const window of [2048, 6000, 32768, 128000]) {
    for (const output of [128, 4096, 32768]) {
      for (const remaining of [0, 100, 1000, 50000, Infinity]) {
        const allowance = contextAllowance(window, output, remaining);
        assert.ok(allowance.maxOutputTokens >= 0);
        assert.ok(allowance.promptTokens >= 0);
        assert.ok(allowance.maxOutputTokens + allowance.promptTokens < window);
        assert.ok(allowance.maxOutputTokens + allowance.promptTokens <= remaining);
      }
    }
  }
});

test('a single research turn with huge arguments and parallel results fits without orphan calls', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Keep the operating restrictions intact.' },
    { role: 'user', content: 'Research NVDA, MU and AMZN. Cite sources and flag uncertainty.' },
  ];
  for (let i = 0; i < 30; i++) {
    messages.push(
      {
        role: 'assistant',
        content: 'Intermediate analysis. '.repeat(200),
        toolCalls: [
          { id: `a${i}`, name: 'search', arguments: { query: 'dense/'.repeat(4000) } },
          { id: `b${i}`, name: 'search', arguments: { query: 'second search' } },
        ],
      },
      { role: 'tool', content: 'Evidence '.repeat(600), toolCallId: `a${i}` },
      { role: 'tool', content: 'More evidence '.repeat(600), toolCallId: `b${i}` },
    );
  }
  const before = structuredClone(messages);
  const result = compactDialog(messages, 2400);
  assert.equal(result.fits, true);
  assert.ok(dialogTokens(result.messages) <= 2400);
  assert.deepEqual(messages, before, 'compaction does not mutate the evidence to be archived');
  assert.equal(result.messages[0].content, messages[0].content);
  assert.ok(result.messages.some((m) => m.content === messages[1].content));
  const calls = result.messages
    .flatMap((m) => m.toolCalls ?? [])
    .map((call) => call.id)
    .sort();
  const results = result.messages
    .filter((m) => m.role === 'tool')
    .map((m) => m.toolCallId)
    .sort();
  assert.deepEqual(calls, results);
});

test('large current requests and assistant prose fit, with trailing request constraints retained', () => {
  const result = compactDialog(
    [
      { role: 'system', content: 'Protect these rules.' },
      {
        role: 'user',
        content: 'Research these stocks: ' + 'background '.repeat(10000) + ' END: include sources.',
      },
      { role: 'assistant', content: 'analysis '.repeat(10000) },
    ],
    500,
  );
  assert.equal(result.fits, true);
  assert.ok(result.messages.at(-1)?.content.startsWith('Research these stocks:'));
  assert.ok(result.messages.at(-1)?.content.endsWith('END: include sources.'));
  assert.match(result.messages.at(-1)!.content, /context omitted/);
});

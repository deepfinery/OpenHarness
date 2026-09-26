import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayAnswer,
  finalAnswerMessages,
  incompleteAnswer,
  readableToolEvidence,
} from '../../packages/core/src/finalAnswer.js';
import type { ChatMessage } from '../../packages/core/src/llm.js';

test('summary evidence decodes MCP envelopes without treating command execution as success', () => {
  const result = readableToolEvidence(
    JSON.stringify({
      content: [{ type: 'text', text: 'Command blocked\nNot allowlisted' }],
      structuredContent: { stdout: '', stderr: 'Command blocked', exit_code: 1 },
      isError: true,
    }),
  );
  assert.match(result, /failure or blocked action/);
  assert.match(result, /Command exit code: 1/);
  assert.match(result, /not whether the task succeeded/);
  assert.match(result, /Command blocked\nNot allowlisted/);
  assert.doesNotMatch(result, /structuredContent|isError/);
  assert.match(
    readableToolEvidence(
      JSON.stringify({
        content: [{ type: 'text', text: 'Partial listing' }],
        structuredContent: { stderr: 'Some directories denied', exit_code: 1 },
      }),
    ),
    /Error output: Some directories denied/,
  );
  assert.equal(
    readableToolEvidence('{"structuredContent":{"stdout":"listing","stderr":"denied"}}'),
    'listing\nError output: denied',
  );
});

test('final synthesis starts without tool calls and includes readable evidence and task instructions', () => {
  const dialog: ChatMessage[] = [
    { role: 'system', content: 'Always inspect using tools.' },
    { role: 'user', content: 'Inspect the host.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call1', name: 'inspect', arguments: {} }] },
    {
      role: 'tool',
      name: 'inspect',
      toolCallId: 'call1',
      content: '{"content":[{"type":"text","text":"Permission denied"}],"isError":true}',
    },
  ];
  const before = JSON.stringify(dialog);
  const messages = finalAnswerMessages('Be accurate.', 'Inspect the host.', dialog, []);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user'],
  );
  assert.ok(messages.every((m) => !m.toolCalls && !m.toolCallId));
  assert.match(messages[0].content, /No tools are available/);
  assert.match(messages[0].content, /Do not invent findings/);
  assert.match(messages[1].content, /Inspect the host/);
  assert.match(messages[1].content, /Permission denied/);
  assert.doesNotMatch(messages[1].content, /isError/);
  assert.equal(JSON.stringify(dialog), before);
});

test('fallback never dumps raw or truncated tool evidence and preserves the incomplete status', () => {
  const result = incompleteAnswer([
    {
      title: 'run_command result (secret-id)',
      kind: 'tool-result',
      snippet: '{"content":[{"type":"text","text":"raw partial',
    },
    { title: 'Blocked inspection', kind: 'finding', snippet: 'UNVERIFIED CLAIM' },
  ]);
  assert.match(result, /assessment is incomplete/);
  assert.match(result, /Blocked inspection/);
  assert.match(result, /Memory and Trace/);
  assert.doesNotMatch(result, /content|raw partial|secret-id|UNVERIFIED CLAIM/);
});

test('historical fallback dumps render readably while intentional JSON answers remain unchanged', () => {
  const old =
    'Analysis stopped at its configured limit, and the model did not provide a final summary. The assessment is incomplete.\n\n- run_command: {"content":[{"type":"text","text":"truncated';
  assert.equal(displayAnswer(old), incompleteAnswer());
  for (const answer of ['{"answer":42}', '```json\n{"ok":true}\n```', 'Your task is complete.'])
    assert.equal(displayAnswer(answer), answer);
});

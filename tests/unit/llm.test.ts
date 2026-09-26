import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerSchema } from '../../packages/core/src/schema.js';
import type { ProviderRecord } from '../../packages/core/src/llm.js';

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.SETUP_TOKEN = 'model-response-tests'.repeat(3);
process.env.ALLOWED_PRIVATE_HOSTS = 'model.test';
const { chat, ModelResponseError } = await import('../../packages/core/src/llm.js');
const provider = providerSchema.parse({
  name: 'Test',
  kind: 'openai-compatible',
  baseUrl: 'http://model.test/v1',
  model: 'test',
}) as ProviderRecord;
const frame = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const call = (args: string, index = 0) => ({
  tool_calls: [{ index, id: `call-${index}`, function: { name: 'run_command', arguments: args } }],
});
function stream(body: string) {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream({
      start(controller) {
        // Break UTF-8 characters and SSE frames across transport chunks.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
const request = (streaming = true) =>
  chat(
    { ...provider, streaming },
    [{ role: 'user', content: 'Inspect the machine' }],
    [],
    undefined,
    () => {},
  );

test('streamed tool arguments survive transport splits, comments, multiline SSE and interleaved calls', async (t) => {
  const body =
    ': keep-alive\r\n\r\n' +
    frame(call('{"argv":["echo",')) +
    frame(call('{}', 1)) +
    frame({ tool_calls: [{ index: 0, function: { arguments: '"héllo 🌍"]}' } }] }) +
    'data: {"choices":\r\ndata: [{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\r\n\r\n' +
    'data: [DONE]\n\n';
  t.mock.method(globalThis, 'fetch', async () => stream(body));
  const result = await request();
  assert.deepEqual(
    result.toolCalls.map((c) => c.arguments),
    [{ argv: ['echo', 'héllo 🌍'] }, {}],
  );
});

for (const streaming of [true, false]) {
  test(`malformed tool arguments are contextual and private (streaming=${streaming})`, async (t) => {
    const args = '{"argv":["' + 's'.repeat(11655); // The reported failure: a long, unterminated JSON string.
    t.mock.method(globalThis, 'fetch', async () =>
      streaming
        ? stream(frame(call('{}', 0)) + frame(call(args, 1)) + frame({}, 'tool_calls'))
        : Response.json({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    { id: 'valid', function: { name: 'run_command', arguments: '{}' } },
                    { id: 'invalid', function: { name: 'run_command', arguments: args } },
                  ],
                },
              },
            ],
          }),
    );
    await assert.rejects(request(streaming), (error: unknown) => {
      assert.ok(error instanceof ModelResponseError);
      assert.equal(error.details.reason, 'tool_arguments');
      assert.equal(error.details.tool, 'run_command');
      assert.equal(error.details.argumentChars, args.length);
      assert.equal(error.details.finishReason, 'tool_calls');
      assert.match(error.message, /No tools from this response were executed/);
      assert.ok(!JSON.stringify(error).includes('s'.repeat(20)));
      return true;
    });
  });
}

for (const [label, body, reason] of [
  ['missing completion', frame(call('{}')), 'incomplete_stream'],
  ['DONE without finish reason', frame(call('{}')) + 'data: [DONE]\n\n', 'incomplete_stream'],
  [
    'corrupt stream event',
    frame(call('{}')) + 'data: {broken}\n\n' + frame({}, 'tool_calls'),
    'invalid_stream',
  ],
  ['output truncation', frame(call('{"argv":["echo')) + frame({}, 'length'), 'output_limit'],
  ['empty stream', ': heartbeat\n\n', 'incomplete_stream'],
] as const) {
  test(`${label} rejects the entire model response`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => stream(body));
    await assert.rejects(
      request(),
      (error: unknown) => error instanceof ModelResponseError && error.details.reason === reason,
    );
  });
}

test('provider stream errors surface instead of returning a partial tool call', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    stream(frame(call('{}')) + 'data: {"error":{"message":"failed"}}\n\n'),
  );
  await assert.rejects(request(), /provider reported an error/);
});

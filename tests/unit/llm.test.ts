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

test('OpenAI streaming requests usage and retains billed truncation usage and visible text, excluding tool arguments', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)).stream_options, { include_usage: true });
    return stream(
      frame({ content: 'Visible draft.' }) +
        frame(call('{"secret":"private unfinished')) +
        frame({}, 'length') +
        'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":4096}}\n\ndata: [DONE]\n\n',
    );
  });
  await assert.rejects(request(), (error: unknown) => {
    assert.ok(error instanceof ModelResponseError);
    assert.equal(error.response?.text, 'Visible draft.');
    assert.equal(error.response?.hasToolCalls, true);
    assert.deepEqual(error.response?.usage, { input: 1200, output: 4096 });
    assert.ok(!JSON.stringify(error).includes('private unfinished'));
    return true;
  });
});

for (const [kind, body] of [
  [
    'openai-compatible',
    {
      choices: [{ finish_reason: 'length', message: { content: 'Visible draft.' } }],
      usage: { prompt_tokens: 100, completion_tokens: 512 },
    },
  ],
  [
    'anthropic',
    {
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'Visible draft.' }],
      usage: { input_tokens: 100, output_tokens: 512 },
    },
  ],
  [
    'gemini',
    {
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          content: { parts: [{ text: 'Hidden reasoning', thought: true }, { text: 'Visible draft.' }] },
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, thoughtsTokenCount: 500 },
    },
  ],
  [
    'ollama',
    {
      done_reason: 'length',
      message: { content: 'Visible draft.' },
      prompt_eval_count: 100,
      eval_count: 512,
    },
  ],
] as const) {
  test(`${kind} non-streaming truncation retains prose and usage for bounded recovery`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(body));
    await assert.rejects(
      chat({ ...provider, kind, streaming: false }, [{ role: 'user', content: 'Answer' }], []),
      (error: unknown) => {
        assert.ok(error instanceof ModelResponseError);
        assert.equal(error.response?.text, 'Visible draft.');
        assert.equal(error.response?.hasToolCalls, false);
        assert.deepEqual(error.response?.usage, { input: 100, output: 512 });
        return true;
      },
    );
  });
}

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

test('transient provider failures are retried with backoff, rejected requests are not', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1)
      return new Response('{"error":{"message":"busy"}}', { status: 503, headers: { 'retry-after': '0' } });
    if (calls === 2) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return stream(frame({ content: 'ready' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  const result = await request();
  assert.equal(result.text, 'ready');
  assert.equal(calls, 3, 'a 503 and a reset connection are each retried once');

  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{"error":{"message":"bad key"}}', { status: 401 });
  });
  await assert.rejects(request(), /HTTP 401/);
  assert.equal(calls, 1, 'a rejected request is not retried');

  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  });
  await assert.rejects(request(), /model\.test is unreachable: ECONNREFUSED \(4 attempts\)/);
  assert.equal(calls, 4, 'connection errors are retried up to four attempts');

  calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
  });
  await assert.rejects(request(), /HTTP 503.*after 4 attempts/);
  assert.equal(calls, 4);
});

test('a provider error inside the stream is a retryable model response error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => stream('data: {"error":{"message":"overloaded"}}\n\n'));
  await assert.rejects(
    request(),
    (e: unknown) =>
      e instanceof ModelResponseError && e.details.reason === 'stream_error' && /overloaded/.test(e.message),
  );
  t.mock.method(globalThis, 'fetch', async () => stream(': keep-alive\n\n'));
  await assert.rejects(
    request(),
    (e: unknown) => e instanceof ModelResponseError && e.details.reason === 'incomplete_stream',
  );
});

for (const streaming of [true, false]) {
  test(`configured route and upstream identity are distinct (streaming=${streaming})`, async (t) => {
    const observed: { url: string; body: any }[] = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      observed.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return streaming
        ? stream(
            'data: ' +
              JSON.stringify({
                id: 'response-1',
                model: 'server-model-alias',
                choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
              }) +
              '\n\ndata: [DONE]\n\n',
          )
        : Response.json({
            id: 'response-1',
            model: 'server-model-alias',
            choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
          });
    });
    const result = await request(streaming);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].url, 'http://model.test/v1/chat/completions');
    assert.equal(observed[0].body.model, 'test');
    assert.equal(result.reportedModel, 'server-model-alias');
    assert.equal(result.responseId, 'response-1');
  });
}

test('model audit strips URL credentials and query secrets; identity contains only configured model', async () => {
  const { modelRoute, modelIdentity } = await import('../../packages/core/src/llm.js');
  const p = {
    ...provider,
    _id: 'provider-1',
    baseUrl: 'https://user:secret@model.test/v1/?key=secret#secret',
    apiKeyEncrypted: 'secret',
    model: 'configured-model',
    revision: 2,
  };
  assert.deepEqual(modelRoute(p), {
    providerId: 'provider-1',
    providerKind: 'openai-compatible',
    providerRevision: 2,
    endpoint: 'https://model.test/v1',
    requestedModel: 'configured-model',
  });
  assert.match(modelIdentity(p).content, /"configured-model"/);
  assert.match(
    modelIdentity(p).content,
    /memories and generated self-descriptions do not establish model identity/,
  );
  assert.ok(!JSON.stringify([modelRoute(p), modelIdentity(p)]).includes('secret'));
});

test('provider rejection never falls back to a different URL or model', async (t) => {
  const observed: { url: string; body: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    observed.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ error: { message: 'Unknown model' } }, { status: 404 });
  });
  await assert.rejects(request(), /HTTP 404/);
  assert.deepEqual(
    observed.map(({ url, body }) => [url, body.model]),
    [['http://model.test/v1/chat/completions', 'test']],
  );
});

for (const kind of ['anthropic', 'gemini', 'ollama'] as const) {
  for (const streaming of [true, false]) {
    test(`${kind} preserves upstream model metadata (streaming=${streaming})`, async (t) => {
      const metadata = { model: 'served-model', id: 'served-id' };
      const gemini = {
        modelVersion: 'served-model',
        responseId: 'served-id',
        candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
      };
      const anthropic = { ...metadata, content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn' };
      const ollama = { ...metadata, message: { content: 'answer' }, done: true };
      t.mock.method(globalThis, 'fetch', async () => {
        if (!streaming)
          return Response.json(kind === 'gemini' ? gemini : kind === 'anthropic' ? anthropic : ollama);
        if (kind === 'ollama')
          return new Response(JSON.stringify(ollama) + '\n', {
            headers: { 'Content-Type': 'application/x-ndjson' },
          });
        const frames =
          kind === 'gemini'
            ? [gemini]
            : [
                { type: 'message_start', message: metadata },
                { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
              ];
        return stream(frames.map((data) => 'data: ' + JSON.stringify(data) + '\n\n').join(''));
      });
      const result = await chat(
        { ...provider, kind, streaming },
        [{ role: 'user', content: 'Hello' }],
        [],
        undefined,
        () => {},
      );
      assert.equal(result.text, 'answer');
      assert.equal(result.reportedModel, 'served-model');
      assert.equal(result.responseId, 'served-id');
    });
  }
}

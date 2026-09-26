// Provider-neutral chat/tool contract with optional token streaming.
import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { decrypt, HttpError, safeFetch } from './security.js';
import type { Provider, Stored } from './schema.js';

export type ProviderRecord = Stored<Provider> & { apiKeyEncrypted?: string; contextTokenScale?: number };
export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown>; signature?: string };
export type ChatMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Internal reference data, distinct from operating instructions and the current user request. */
  reference?: boolean;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
};
export type ChatResult = { text: string; toolCalls: ToolCall[]; usage?: { input: number; output: number } };
/** Receives text as the model produces it. Tool calls are never streamed; they arrive in the result. */
export type DeltaListener = (text: string) => void;

export async function ownedProvider(ownerId: string, id: string) {
  const p = await collection<ProviderRecord>('providers').findOne({ _id: id, ownerId });
  if (!p) throw new HttpError(404, 'Model provider not found');
  return p;
}
function endpoint(p: Provider, path: string) {
  return `${p.baseUrl.replace(/\/+$/, '')}${path}`;
}
async function failedResponse(response: Response) {
  const body = await response.text().catch(() => '');
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    const message = parsed.error?.message ?? parsed.error ?? parsed.message ?? body;
    detail = typeof message === 'string' ? message : JSON.stringify(message);
  } catch {
    // Not JSON; keep the raw body text.
  }
  return new Error(
    `Model provider returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}. Check the endpoint, model, credentials and quota.`,
  );
}
async function post(url: string, payload: unknown, headers: Record<string, string>, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(180000);
  const response = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  });
  if (!response.ok) throw await failedResponse(response);
  return response;
}
async function jsonRequest(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  const response = await post(url, payload, headers, signal);
  // Each provider has its own wire format; normalized and validated below before use.
  return (await response.json()) as any;
}
/** A response rejected before any of its tool calls can be dispatched. Never includes raw arguments. */
export class ModelResponseError extends Error {
  constructor(
    message: string,
    public details: {
      reason: 'tool_arguments' | 'invalid_stream' | 'incomplete_stream' | 'output_limit';
      tool?: string;
      argumentChars?: number;
      finishReason?: string;
    },
  ) {
    super(message);
    this.name = 'ModelResponseError';
  }
}
function argumentsObject(input: unknown, tool?: string, finishReason?: string): Record<string, unknown> {
  const invalid = () =>
    new ModelResponseError(
      `Model returned malformed or incomplete JSON arguments${tool ? ` for tool ${tool}` : ''}. No tools from this response were executed.`,
      {
        reason: 'tool_arguments',
        tool,
        argumentChars: typeof input === 'string' ? input.length : undefined,
        finishReason,
      },
    );
  let value: unknown;
  try {
    value = typeof input === 'string' ? JSON.parse(input || '{}') : input;
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
/** Yields one complete line at a time from a streaming body. */
async function* lines(response: Response, signal?: AbortSignal) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Yields parsed JSON `data:` payloads from a server-sent-events body, with the preceding event name. */
async function* sse(response: Response, signal?: AbortSignal): AsyncGenerator<{ event: string; data: any }> {
  let event = '';
  let data: string[] = [];
  function parse() {
    const payload = data.join('\n');
    data = [];
    const name = event;
    event = '';
    if (!payload || payload === '[DONE]') return;
    try {
      return { event: name, data: JSON.parse(payload) };
    } catch {
      throw new ModelResponseError(
        'Model provider sent an invalid JSON stream event. No tools from this response were executed.',
        { reason: 'invalid_stream' },
      );
    }
  }
  for await (const line of lines(response, signal)) {
    if (!line) {
      const parsed = parse();
      if (parsed) yield parsed;
    } else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) {
    const parsed = parse();
    if (parsed) yield parsed;
  }
}
const isStream = (response: Response, ...types: string[]) =>
  types.some((t) => (response.headers.get('content-type') ?? '').includes(t));

export async function chat(
  p: ProviderRecord,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
  onDelta?: DeltaListener,
): Promise<ChatResult> {
  const key = decrypt(p.apiKeyEncrypted);
  const streaming = Boolean(onDelta) && p.streaming !== false;
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  if (p.kind === 'anthropic') {
    const dialog = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content:
          m.role === 'tool'
            ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
            : [
                ...(m.content ? [{ type: 'text', text: m.content }] : []),
                ...(m.toolCalls ?? []).map((t) => ({
                  type: 'tool_use',
                  id: t.id,
                  name: t.name,
                  input: t.arguments,
                })),
              ],
      }));
    const payload = {
      model: p.model,
      system,
      messages: dialog,
      max_tokens: p.maxOutputTokens,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
          }
        : {}),
    };
    const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const url = endpoint(p, '/messages');
    if (streaming) {
      const response = await post(url, { ...payload, stream: true }, headers, signal);
      if (isStream(response, 'text/event-stream')) {
        let text = '';
        const blocks = new Map<number, { id: string; name: string; json: string }>();
        const usage = { input: 0, output: 0 };
        let stopReason = '';
        for await (const { data } of sse(response, signal)) {
          switch (data.type) {
            case 'message_start':
              usage.input = data.message?.usage?.input_tokens ?? 0;
              break;
            case 'content_block_start':
              if (data.content_block?.type === 'tool_use')
                blocks.set(data.index, {
                  id: data.content_block.id,
                  name: data.content_block.name,
                  json: '',
                });
              break;
            case 'content_block_delta':
              if (data.delta?.type === 'text_delta') {
                text += data.delta.text;
                onDelta!(data.delta.text);
              } else if (data.delta?.type === 'input_json_delta') {
                const block = blocks.get(data.index);
                if (block) block.json += data.delta.partial_json;
              }
              break;
            case 'message_delta':
              stopReason = data.delta?.stop_reason ?? stopReason;
              usage.output = data.usage?.output_tokens ?? usage.output;
              break;
          }
        }
        if (stopReason === 'max_tokens')
          throw new Error('Model output limit reached; increase the provider output budget');
        return {
          text,
          toolCalls: [...blocks.values()].map((b) => ({
            id: b.id,
            name: b.name,
            arguments: argumentsObject(b.json, b.name),
          })),
          usage,
        };
      }
      return anthropicResult(await response.json());
    }
    return anthropicResult(await jsonRequest(url, payload, headers, signal));
  }
  if (p.kind === 'gemini') {
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          m.role === 'tool'
            ? [{ functionResponse: { name: m.name, response: { result: m.content } } }]
            : [
                ...(m.content ? [{ text: m.content }] : []),
                ...(m.toolCalls ?? []).map((t) => ({
                  functionCall: { name: t.name, args: t.arguments },
                  ...(t.signature ? { thoughtSignature: t.signature } : {}),
                })),
              ],
      }));
    const payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: p.maxOutputTokens },
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.inputSchema,
                })),
              },
            ],
          }
        : {}),
    };
    const headers = { 'x-goog-api-key': key };
    const model = encodeURIComponent(p.model);
    if (streaming) {
      const response = await post(
        endpoint(p, `/models/${model}:streamGenerateContent?alt=sse`),
        payload,
        headers,
        signal,
      );
      if (isStream(response, 'text/event-stream')) {
        let text = '';
        const toolCalls: ToolCall[] = [];
        let finish = '';
        let usage = { input: 0, output: 0 };
        for await (const { data } of sse(response, signal)) {
          const candidate = data.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (typeof part.text === 'string' && !part.thought) {
              text += part.text;
              onDelta!(part.text);
            }
            if (part.functionCall)
              toolCalls.push({
                id: randomUUID(),
                name: part.functionCall.name,
                arguments: argumentsObject(part.functionCall.args, part.functionCall.name),
                signature: part.thoughtSignature,
              });
          }
          finish = candidate?.finishReason ?? finish;
          if (data.usageMetadata)
            usage = {
              input: data.usageMetadata.promptTokenCount ?? usage.input,
              output: data.usageMetadata.candidatesTokenCount ?? usage.output,
            };
        }
        if (['MAX_TOKENS', 'SAFETY', 'RECITATION'].includes(finish))
          throw new Error(`Model did not complete: ${finish}`);
        return { text, toolCalls, usage };
      }
      return geminiResult(await response.json());
    }
    return geminiResult(
      await jsonRequest(endpoint(p, `/models/${model}:generateContent`), payload, headers, signal),
    );
  }
  const nativeOllama = p.kind === 'ollama';
  const dialog = messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCallId ? { tool_call_id: m.toolCallId, ...(nativeOllama ? { tool_name: m.name } : {}) } : {}),
    ...(m.toolCalls?.length
      ? {
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: nativeOllama ? t.arguments : JSON.stringify(t.arguments) },
          })),
        }
      : {}),
  }));
  const payload = {
    model: p.model,
    messages: dialog,
    stream: streaming,
    ...(nativeOllama
      ? { options: { num_predict: p.maxOutputTokens } }
      : { [p.outputTokenParameter ?? 'max_tokens']: p.maxOutputTokens }),
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
  };
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const url = endpoint(p, nativeOllama ? '/api/chat' : '/chat/completions');
  if (!streaming) return openAiResult(await jsonRequest(url, payload, headers, signal), nativeOllama);
  const response = await post(url, payload, headers, signal);
  if (nativeOllama && isStream(response, 'application/x-ndjson', 'application/json')) {
    let text = '';
    const toolCalls: ToolCall[] = [];
    let usage = { input: 0, output: 0 };
    let doneReason = '';
    let sawChunk = false;
    for await (const line of lines(response, signal)) {
      if (!line.trim()) continue;
      const data = JSON.parse(line);
      sawChunk = true;
      if (data.message?.content) {
        text += data.message.content;
        onDelta!(data.message.content);
      }
      for (const t of data.message?.tool_calls ?? [])
        toolCalls.push({
          id: t.id || randomUUID(),
          name: t.function.name,
          arguments: argumentsObject(t.function.arguments, t.function.name),
        });
      if (data.done) {
        doneReason = data.done_reason ?? '';
        usage = { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 };
      }
      if (!data.done && data.message === undefined && data.choices) {
        // An OpenAI-style body on the Ollama endpoint: treat it as a single JSON response.
        return openAiResult(data, false);
      }
    }
    if (!sawChunk) throw new Error('Model provider returned an empty stream');
    if (doneReason === 'length')
      throw new Error('Model output limit reached; increase the provider output budget');
    return { text, toolCalls, usage };
  }
  if (!nativeOllama && isStream(response, 'text/event-stream')) {
    let text = '';
    const pending = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: ChatResult['usage'];
    let finish = '';
    for await (const { data } of sse(response, signal)) {
      if (data.error) throw new Error('Model provider reported an error in its response stream');
      const choice = data.choices?.[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        onDelta!(choice.delta.content);
      }
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? pending.size;
        const entry = pending.get(index) ?? { id: '', name: '', arguments: '' };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name += call.function.name;
        if (call.function?.arguments) entry.arguments += call.function.arguments;
        pending.set(index, entry);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (data.usage)
        usage = { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 };
    }
    if (!finish)
      throw new ModelResponseError(
        'Model provider stream ended before completion. No tools from this response were executed.',
        { reason: 'incomplete_stream' },
      );
    if (finish === 'length')
      throw new ModelResponseError(
        'Model output limit reached; use shorter tool arguments or increase the provider output budget',
        { reason: 'output_limit', finishReason: finish },
      );
    if (!['stop', 'tool_calls', 'function_call'].includes(finish))
      throw new Error(`Model did not complete: ${finish}`);
    return {
      text,
      toolCalls: [...pending.values()].map((t) => ({
        id: t.id || randomUUID(),
        name: t.name,
        arguments: argumentsObject(t.arguments, t.name, finish),
      })),
      usage,
    };
  }
  // The server ignored `stream`; read the complete JSON body instead.
  return openAiResult(await response.json(), nativeOllama);
}
function anthropicResult(data: any): ChatResult {
  if (data.stop_reason === 'max_tokens')
    throw new Error('Model output limit reached; increase the provider output budget');
  return {
    text: (data.content ?? [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n'),
    toolCalls: (data.content ?? [])
      .filter((c: any) => c.type === 'tool_use')
      .map((c: any) => ({ id: c.id, name: c.name, arguments: argumentsObject(c.input, c.name) })),
    usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
  };
}
function geminiResult(data: any): ChatResult {
  const candidate = data.candidates?.[0];
  if (!candidate || ['MAX_TOKENS', 'SAFETY', 'RECITATION'].includes(candidate.finishReason))
    throw new Error(`Model did not complete: ${candidate?.finishReason ?? 'no candidate'}`);
  const parts = candidate.content?.parts ?? [];
  return {
    text: parts
      .filter((c: any) => typeof c.text === 'string' && !c.thought)
      .map((c: any) => c.text)
      .join('\n'),
    toolCalls: parts
      .filter((c: any) => c.functionCall)
      .map((c: any) => ({
        id: randomUUID(),
        name: c.functionCall.name,
        arguments: argumentsObject(c.functionCall.args, c.functionCall.name),
        signature: c.thoughtSignature,
      })),
    usage: {
      input: data.usageMetadata?.promptTokenCount ?? 0,
      output: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}
function openAiResult(data: any, nativeOllama: boolean): ChatResult {
  if (data.choices?.[0]?.finish_reason === 'length' || data.done_reason === 'length')
    throw new ModelResponseError(
      'Model output limit reached; use shorter tool arguments or increase the provider output budget',
      { reason: 'output_limit', finishReason: 'length' },
    );
  const message = nativeOllama ? data.message : data.choices?.[0]?.message;
  if (!message) throw new Error('Model provider returned no message');
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: (message.tool_calls ?? []).map((t: any) => ({
      id: t.id || randomUUID(),
      name: t.function.name,
      arguments: argumentsObject(
        t.function.arguments,
        t.function.name,
        data.choices?.[0]?.finish_reason ?? data.done_reason,
      ),
    })),
    usage: {
      input: data.usage?.prompt_tokens ?? data.prompt_eval_count ?? 0,
      output: data.usage?.completion_tokens ?? data.eval_count ?? 0,
    },
  };
}
export async function embed(p: ProviderRecord, input: string, signal?: AbortSignal): Promise<number[]> {
  if (!p.embeddingModel) throw new Error('Configure an embedding model on the knowledge base provider');
  const key = decrypt(p.apiKeyEncrypted);
  let vector: unknown;
  if (p.kind === 'gemini') {
    const data = await jsonRequest(
      endpoint(p, `/models/${encodeURIComponent(p.embeddingModel)}:embedContent`),
      { content: { parts: [{ text: input }] } },
      { 'x-goog-api-key': key },
      signal,
    );
    vector = data.embedding?.values;
  } else if (p.kind === 'ollama') {
    const data = await jsonRequest(
      endpoint(p, '/api/embed'),
      { model: p.embeddingModel, input },
      key ? { Authorization: `Bearer ${key}` } : {},
      signal,
    );
    vector = data.embeddings?.[0];
  } else if (p.kind === 'openai-compatible') {
    const data = await jsonRequest(
      endpoint(p, '/embeddings'),
      { model: p.embeddingModel, input },
      key ? { Authorization: `Bearer ${key}` } : {},
      signal,
    );
    vector = data.data?.[0]?.embedding;
  } else throw new Error('Choose an OpenAI-compatible, Gemini or Ollama provider for embeddings');
  if (
    !Array.isArray(vector) ||
    vector.length < 2 ||
    !vector.every((x) => typeof x === 'number' && Number.isFinite(x))
  )
    throw new Error('Embedding provider returned an invalid vector');
  return vector;
}

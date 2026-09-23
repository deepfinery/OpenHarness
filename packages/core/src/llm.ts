// Provider-neutral chat/tool contract adapted from the source workflow llmClient.
import { randomUUID } from 'node:crypto';
import { collection } from './db.js';
import { decrypt, HttpError, safeFetch } from './security.js';
import type { Provider, Stored } from './schema.js';

export type ProviderRecord = Stored<Provider> & { apiKeyEncrypted?: string };
export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown>; signature?: string };
export type ChatMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
};
export type ChatResult = { text: string; toolCalls: ToolCall[]; usage?: { input: number; output: number } };
export async function ownedProvider(ownerId: string, id: string) {
  const p = await collection<ProviderRecord>('providers').findOne({ _id: id, ownerId });
  if (!p) throw new HttpError(404, 'Model provider not found');
  return p;
}
function endpoint(p: Provider, path: string) {
  return `${p.baseUrl.replace(/\/+$/, '')}${path}`;
}
async function jsonRequest(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(120000);
  const response = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Model provider returned HTTP ${response.status}. Check the endpoint, model, credentials and quota.`,
    );
  }
  // Each provider has its own wire format; normalized and validated below before use.
  return (await response.json()) as any;
}
function argumentsObject(input: unknown): Record<string, unknown> {
  const value = typeof input === 'string' ? JSON.parse(input || '{}') : input;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The model returned invalid tool arguments');
  return value as Record<string, unknown>;
}
export async function chat(
  p: ProviderRecord,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
): Promise<ChatResult> {
  const key = decrypt(p.apiKeyEncrypted);
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
    const data = await jsonRequest(
      endpoint(p, '/messages'),
      {
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
      },
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal,
    );
    if (data.stop_reason === 'max_tokens')
      throw new Error('Model output limit reached; increase the provider output budget');
    return {
      text: (data.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n'),
      toolCalls: (data.content ?? [])
        .filter((c: any) => c.type === 'tool_use')
        .map((c: any) => ({ id: c.id, name: c.name, arguments: argumentsObject(c.input) })),
      usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 },
    };
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
    const data = await jsonRequest(
      endpoint(p, `/models/${encodeURIComponent(p.model)}:generateContent`),
      {
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
      },
      { 'x-goog-api-key': key },
      signal,
    );
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
          arguments: argumentsObject(c.functionCall.args),
          signature: c.thoughtSignature,
        })),
      usage: {
        input: data.usageMetadata?.promptTokenCount ?? 0,
        output: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
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
  const data = await jsonRequest(
    endpoint(p, nativeOllama ? '/api/chat' : '/chat/completions'),
    {
      model: p.model,
      messages: dialog,
      stream: false,
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
    },
    key ? { Authorization: `Bearer ${key}` } : {},
    signal,
  );
  if (data.choices?.[0]?.finish_reason === 'length' || data.done_reason === 'length')
    throw new Error('Model output limit reached; increase the provider output budget');
  const message = nativeOllama ? data.message : data.choices?.[0]?.message;
  if (!message) throw new Error('Model provider returned no message');
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: (message.tool_calls ?? []).map((t: any) => ({
      id: t.id || randomUUID(),
      name: t.function.name,
      arguments: argumentsObject(t.function.arguments),
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

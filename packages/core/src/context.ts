// Keeps a multi-turn dialog inside a model's context window without breaking tool-call pairing.
import type { ChatMessage } from './llm.js';

/** Signals a capacity problem, never a credentials, transport or cancellation failure. */
export class ContextCapacityError extends Error {}

/** Reserve output and tokenizer/wire-format headroom before allocating the prompt. */
export function contextAllowance(window: number, output: number, remaining = Infinity) {
  const margin = Math.max(256, Math.ceil(window * 0.08));
  const available = Math.max(0, Math.min(window - margin, remaining));
  const maxOutputTokens = Math.max(0, Math.min(output, Math.floor(available / 2)));
  return { maxOutputTokens, promptTokens: Math.max(0, available - maxOutputTokens) };
}

/** Keep both the request and its trailing constraints when emergency shortening is necessary. */
export function excerpt(text: string, chars: number): string {
  chars = Math.max(0, Math.floor(chars));
  if (text.length <= chars) return text;
  const marker = '\n…[context omitted; consult saved task memory]…\n';
  if (chars <= marker.length) return text.slice(0, Math.max(0, chars));
  const head = Math.ceil((chars - marker.length) * 0.65);
  const tail = chars - marker.length - head;
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : '');
}

/** Conservative estimate: most tokenizers average 3.5–4 characters per token on mixed text and JSON. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
export function dialogTokens(messages: ChatMessage[]) {
  return messages.reduce(
    (n, m) =>
      n + estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) + 6,
    0,
  );
}
export const isContextLengthError = (message: string) =>
  /maximum context length|context[_ ]length|context window|too many tokens|prompt is too long|input is too long|exceeds? the (?:model'?s?|maximum)|token limit|max_tokens.*(?:exceed|greater)|tokens? (?:exceed|over)/i.test(
    message,
  );
/** How many prompt tokens the provider says it counted, when its error says (vLLM, OpenAI, Anthropic wordings). */
export function promptTokensFromError(message: string): number | undefined {
  const patterns = [
    /prompt contains at least (\d+) input tokens/i,
    /(\d+) in the messages/i,
    /messages resulted in (\d+) tokens/i,
    /prompt is too long: (\d+) tokens/i,
    /input (?:length|tokens?)(?: is| of)? (\d+)/i,
  ];
  for (const p of patterns) {
    const m = p.exec(message);
    if (m) return Number(m[1]);
  }
  return undefined;
}
/** The limit a provider states in its error, when it states one (OpenAI, vLLM, Ollama, Anthropic wordings). */
export function contextLimitFromError(message: string): number | undefined {
  const patterns = [
    /maximum context length is (\d+)/i,
    /context window of (\d+)/i,
    /context length of (\d+)/i,
    /limit(?: of)? (\d+) tokens/i,
    /(\d+) tokens? (?:context|limit|maximum)/i,
  ];
  for (const p of patterns) {
    const m = p.exec(message);
    if (m) return Number(m[1]);
  }
  return undefined;
}

const TRUNCATED = '\n…[earlier tool result truncated to fit the model context]';
function truncate(m: ChatMessage, chars: number): ChatMessage {
  return m.content.length > chars + TRUNCATED.length
    ? { ...m, content: m.content.slice(0, chars) + TRUNCATED }
    : m;
}
/** Splits messages after the system prompt into turn groups that start at each user message. */
function groups(messages: ChatMessage[]) {
  const out: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role === 'user' || !out.length) out.push([m]);
    else out[out.length - 1].push(m);
  }
  return out;
}

/**
 * Fits `messages` under `budget` tokens, escalating only as far as needed and never past `maxLevel`.
 * Level 1 shortens older tool results; level 2 also drops the oldest completed turns (keeping the system
 * prompt and the current turn); level 3 also trims the current turn's tool exchanges and text. System instructions are never truncated.
 * `fits` must be checked by callers: instructions alone can exceed the available budget.
 * Assistant tool calls always stay with their tool results.
 */
export function compactDialog(
  messages: ChatMessage[],
  budget: number,
  maxLevel: 1 | 2 | 3 = 3,
): { messages: ChatMessage[]; changed: boolean; tokens: number; level: 0 | 1 | 2 | 3; fits: boolean } {
  if (dialogTokens(messages) <= budget)
    return { messages, changed: false, tokens: dialogTokens(messages), level: 0, fits: true };
  const system = messages.filter((m) => m.role === 'system');
  let rest = messages.filter((m) => m.role !== 'system');
  let level: 1 | 2 | 3 = 1;
  const fits = () => dialogTokens([...system, ...rest]) <= budget;

  // Level 1: older tool results carry little value once the model has used them; the latest stays intact.
  const toolIndexes = rest.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIndexes.slice(0, -1)) rest[i] = truncate(rest[i], 600);
  if (fits() || maxLevel < 2) return finish();

  // Level 2: drop completed turns from the oldest onward, never the current one.
  level = 2;
  let turns = groups(rest);
  while (turns.length > 1 && !fits()) {
    turns = turns.slice(1);
    rest = turns.flat();
  }
  if (fits() || maxLevel < 3) return finish();

  // Remove complete exchanges, including large call arguments, instead of leaving orphan results.
  level = 3;
  rest = rest.map((m) => (m.role === 'tool' ? truncate(m, 300) : m));
  while (!fits()) {
    const start = rest.findIndex((m) => m.role === 'assistant' && m.toolCalls?.length);
    if (start < 0) break;
    let end = start + 1;
    while (rest[end]?.role === 'tool') end++;
    rest.splice(start, end - start);
  }
  // Older assistant prose can be just as large as tool results. Keep the latest user request longest.
  while (!fits() && rest.length > 1) {
    const lastUser = rest.map((m) => m.role).lastIndexOf('user');
    const index = rest.findIndex((_, i) => i !== lastUser);
    if (index < 0) break;
    rest.splice(index, 1);
  }
  if (!fits() && rest.length) {
    const chars = Math.max(0, Math.floor((budget - dialogTokens(system) - 7) * 3.5));
    rest = rest.map((m) => ({ ...m, content: excerpt(m.content, chars) }));
  }
  return finish();

  function finish() {
    const out = [...system, ...rest];
    return {
      messages: out,
      changed: true,
      tokens: dialogTokens(out),
      level,
      fits: dialogTokens(out) <= budget,
    };
  }
}

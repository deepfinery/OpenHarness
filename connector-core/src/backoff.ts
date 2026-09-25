/**
 * Reconnect delay for `attempt` (0-based): exponential from `baseMs`, capped at `maxMs`, with equal jitter
 * so the delay lies in [cap/2, cap). 1 s → 60 s by default, as PROTOCOL.md §5 requires.
 */
export function backoffDelay(
  attempt: number,
  {
    baseMs = 1000,
    maxMs = 60_000,
    random = Math.random,
  }: { baseMs?: number; maxMs?: number; random?: () => number } = {},
) {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.floor(cap / 2 + random() * (cap / 2));
}

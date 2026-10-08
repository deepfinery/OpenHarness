/**
 * Budgets that can be switched off. A limit of `0` means "no limit": the runtime represents it as UNLIMITED so
 * every comparison against the budget stays false, and timers are only armed for real deadlines.
 */
export const UNLIMITED = Number.MAX_SAFE_INTEGER;
/** Whether a configured limit means "no limit" (`0`, or already normalised to UNLIMITED). */
export const unlimited = (limit: number | undefined | null) =>
  limit === undefined || limit === null || limit <= 0 || limit >= UNLIMITED;
/** The runtime value of a configured limit: UNLIMITED for `0`, otherwise the limit itself. */
export const effectiveLimit = (limit: number | undefined | null, fallback: number) =>
  limit === undefined || limit === null ? fallback : limit <= 0 ? UNLIMITED : limit;
/** A limit for people: "unlimited", or the number with its unit. */
export const limitText = (limit: number | undefined | null, unit: string) =>
  unlimited(limit) ? 'unlimited' : `${Number(limit).toLocaleString()} ${unit}`;
/** The longest delay a JavaScript timer accepts (about 24.8 days); longer deadlines are armed in that range. */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * An AbortSignal that fires after `ms`. Node clamps a longer delay to 1 ms and fires at once, which would end a
 * month-long run immediately, so the delay is capped at the longest timer the platform accepts.
 */
export const deadlineSignal = (ms: number) =>
  AbortSignal.timeout(Math.min(Math.max(1, Math.ceil(ms)), MAX_TIMER_MS));
/** `signal` combined with a deadline, or `signal` alone when there is no deadline. */
export const withDeadline = (signal: AbortSignal, ms: number | undefined) =>
  ms === undefined || unlimited(ms) ? signal : AbortSignal.any([signal, deadlineSignal(ms)]);

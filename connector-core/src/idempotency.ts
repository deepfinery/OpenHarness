/** Remembers results by idempotency key so a replayed tool call (after a reconnect) does not act twice. */
export class IdempotencyCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 1000,
  ) {}
  get(key: string | undefined): T | undefined {
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string | undefined, value: T) {
    if (!key) return;
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

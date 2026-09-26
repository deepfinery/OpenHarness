/** Shared validation for agent and schedule timezones; never infer a user's location from the host. */
export function validTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** One server-owned reference instant per execution, shared by workflow steps and delegated tasks. */
export function timeContext(referenceTime: string, requestedTimezone?: string) {
  const timezone = requestedTimezone && validTimeZone(requestedTimezone) ? requestedTimezone : 'UTC';
  const instant = new Date(referenceTime);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(instant)
      .map(({ type, value }) => [type, value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // ICU versions differ on zero offset (GMT versus GMT+00:00). Always make the offset explicit.
  const offset = parts.timeZoneName === 'GMT' ? 'GMT+00:00' : parts.timeZoneName;
  // Calendar arithmetic on date labels, not elapsed local hours: DST weeks can have 167 or 169 hours.
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const start = new Date(monday);
  start.setUTCDate(start.getUTCDate() - 7);
  const end = new Date(monday);
  end.setUTCDate(end.getUTCDate() - 1);
  return {
    referenceTime: instant.toISOString(),
    timezone,
    localTime: `${date} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`,
    lastWeek: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
  };
}

export function timeContextPrompt(clock: ReturnType<typeof timeContext>): string {
  return `\n\n[Runtime clock]\nUTC at execution start: ${clock.referenceTime}. Local: ${clock.localTime} (${clock.timezone}). Last completed calendar week (Mon–Sun, inclusive): ${clock.lastWeek.start} to ${clock.lastWeek.end}.
Resolve relative dates from this clock, never training data or old messages/notes. Respect explicit dates/timezones; state the range used. Distinguish rolling seven days; for markets use the latest completed trading week, checking exchange holidays.
For current/latest news, retrieve fresh sources with available search tools. Include concrete dates in queries and use date filters only as defined by the tool schema. Verify publication AND event dates; old notes are not current evidence. Cite dated sources. If current evidence is unavailable, say so; do not present older reporting as latest.`;
}

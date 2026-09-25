// Computes when a periodic schedule fires next. Pure, so it is unit-tested without a database.
import type { Schedule } from './schema.js';

/** Offset of `timeZone` from UTC at `date`, in milliseconds (positive east of Greenwich). */
function offsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}
/** The first instant after `from` whose wall-clock time in `timeZone` is `at` (and `weekday`, when given). */
export function nextWallClock(at: string, timeZone: string, weekday: number | undefined, from: Date) {
  const [hh, mm] = at.split(':').map(Number);
  const local = new Date(from.getTime() + offsetMs(from, timeZone));
  for (let day = 0; day < 9; day++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hh, mm);
    if (weekday !== undefined && new Date(wall).getUTCDay() !== weekday) continue;
    // Convert the wall time back to an instant, re-reading the offset in case DST changes on that day.
    let instant = new Date(wall - offsetMs(from, timeZone));
    instant = new Date(wall - offsetMs(instant, timeZone));
    if (instant.getTime() > from.getTime() + 999) return instant;
  }
  return new Date(from.getTime() + 86400000);
}
/** When a schedule fires next after `from`: aligned to its wall-clock time when it has one, else a fixed interval. */
export function nextScheduledAt(schedule: Schedule, from = new Date()) {
  if (schedule.at && schedule.everyMinutes >= 1440) {
    const tz = schedule.timezone ?? 'UTC';
    const daily = nextWallClock(schedule.at, tz, undefined, from);
    if (schedule.everyMinutes >= 10080 && schedule.weekday !== undefined)
      return nextWallClock(schedule.at, tz, schedule.weekday, from);
    if (schedule.everyMinutes === 1440) return daily;
    // Every N days at a time: step whole days from the next daily slot.
    return new Date(daily.getTime() + (schedule.everyMinutes / 1440 - 1) * 86400000);
  }
  return new Date(from.getTime() + schedule.everyMinutes * 60000);
}
export function describeSchedule(schedule: Schedule | undefined) {
  if (!schedule?.enabled) return 'Off';
  const m = schedule.everyMinutes;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const at = schedule.at ? ` at ${schedule.at}` : '';
  if (m === 1) return 'Every minute';
  if (m < 60) return `Every ${m} minutes`;
  if (m === 60) return 'Every hour';
  if (m < 1440) return m % 60 ? `Every ${m} minutes` : `Every ${m / 60} hours`;
  if (m === 1440) return `Every day${at}`;
  if (m === 10080) return `Every ${schedule.weekday !== undefined ? days[schedule.weekday] : 'week'}${at}`;
  return m % 1440 ? `Every ${m} minutes` : `Every ${m / 1440} days${at}`;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeContext, timeContextPrompt } from '../../packages/core/src/timeContext.js';
import { agentSchema } from '../../packages/core/src/schema.js';
import { compactDialog } from '../../packages/core/src/context.js';

test('last week uses the local calendar across UTC and year boundaries', () => {
  const utc = timeContext('2026-01-05T01:30:00Z');
  assert.equal(utc.timezone, 'UTC');
  assert.equal(utc.localTime, '2026-01-05 01:30:00 GMT+00:00');
  assert.deepEqual(utc.lastWeek, { start: '2025-12-29', end: '2026-01-04' });
  const newYork = timeContext('2026-01-05T01:30:00Z', 'America/New_York');
  assert.equal(newYork.localTime, '2026-01-04 20:30:00 GMT-05:00');
  assert.deepEqual(newYork.lastWeek, { start: '2025-12-22', end: '2025-12-28' });
  assert.equal(
    timeContext('2026-01-04T23:30:00Z', 'Asia/Kathmandu').localTime,
    '2026-01-05 05:15:00 GMT+05:45',
  );
});

test('DST changes preserve calendar week boundaries and report the correct local offset', () => {
  for (const [instant, offset, start, end] of [
    ['2026-03-09T12:00:00Z', 'GMT-04:00', '2026-03-02', '2026-03-08'],
    ['2026-11-02T12:00:00Z', 'GMT-05:00', '2026-10-26', '2026-11-01'],
  ]) {
    const clock = timeContext(instant, 'America/New_York');
    assert.ok(clock.localTime.endsWith(offset));
    assert.deepEqual(clock.lastWeek, { start, end });
  }
});

test('invalid configured timezones are rejected and legacy invalid data falls back to UTC', () => {
  const agent = { name: 'A', systemPrompt: 'Research', providerId: '11111111-1111-4111-8111-111111111111' };
  assert.equal(agentSchema.safeParse({ ...agent, timezone: 'Mars/Olympus' }).success, false);
  assert.equal(agentSchema.parse({ ...agent, timezone: ' America/New_York ' }).timezone, 'America/New_York');
  assert.equal(agentSchema.parse(agent).timezone, undefined);
  assert.equal(timeContext('2026-09-26T12:00:00Z', 'Mars/Olympus').timezone, 'UTC');
});

test('the clock and source freshness instructions survive context compaction intact', () => {
  const prompt = timeContextPrompt(timeContext('2026-09-26T12:00:00Z'));
  const result = compactDialog(
    [
      { role: 'system', content: prompt },
      { role: 'assistant', content: 'Last week was March 17–21, 2025. '.repeat(400) },
      { role: 'user', content: 'What happened last week?' },
    ],
    600,
  );
  assert.equal(result.fits, true);
  assert.equal(result.messages[0].content, prompt);
  assert.match(prompt, /2026-09-14 to 2026-09-20/);
});

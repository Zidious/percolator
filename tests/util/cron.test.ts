import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cronMatches, knownTimeZone, latestTick, parseCron, wallClock } from '../../src/util/cron.ts';

const HINT = '; use five fields: minute hour day-of-month month day-of-week';

test('parses lists, ranges and steps', () => {
  const c = parseCron('0,15 9-17/4 */10 1-3 1-5');
  assert.deepEqual(c.minute, [0, 15]);
  assert.deepEqual(c.hour, [9, 13, 17]);
  assert.deepEqual(c.dom, [1, 11, 21, 31]);
  assert.deepEqual(c.month, [1, 2, 3]);
  assert.deepEqual(c.dow, [1, 2, 3, 4, 5]);
});

test('refuses a four-field expression', () => {
  assert.throws(() => parseCron('* * * *'), { message: `cron "* * * *": needs 5 fields, got 4${HINT}` });
});

test('refuses an out-of-range hour', () => {
  assert.throws(() => parseCron('0 24 * * *'), {
    message: `cron "0 24 * * *": hour value 24 is out of range 0-23${HINT}`,
  });
});

test('refuses a day name', () => {
  assert.throws(() => parseCron('0 9 * * MON'), {
    message: `cron "0 9 * * MON": cannot read "MON" in day-of-week${HINT}`,
  });
});

test('day-of-month or day-of-week matches when both are set', () => {
  const both = parseCron('0 0 1 * 5');
  const sunFirst = wallClock(new Date('2026-11-01T00:00Z'), 'UTC');
  const friday = wallClock(new Date('2026-11-06T00:00Z'), 'UTC');
  const tuesday = wallClock(new Date('2026-11-03T00:00Z'), 'UTC');
  assert.equal(cronMatches(both, sunFirst), true);
  assert.equal(cronMatches(both, friday), true);
  assert.equal(cronMatches(both, tuesday), false);
  assert.equal(cronMatches(parseCron('0 0 * * 5'), sunFirst), false);
});

test('7 is Sunday', () => {
  const c = parseCron('0 0 * * 7');
  assert.equal(cronMatches(c, wallClock(new Date('2026-11-22T00:00Z'), 'UTC')), true);
  assert.equal(cronMatches(c, wallClock(new Date('2026-11-23T00:00Z'), 'UTC')), false);
});

test('latestTick finds the latest match in a window', () => {
  const c = parseCron('*/15 * * * *');
  const tick = latestTick(c, new Date('2026-11-22T10:00Z'), new Date('2026-11-22T10:50:30Z'), 'UTC');
  assert.deepEqual(tick, { at: new Date('2026-11-22T10:45Z'), key: '2026-11-22T10:45' });
  assert.equal(latestTick(c, new Date('2026-11-22T10:45Z'), new Date('2026-11-22T10:50Z'), 'UTC'), undefined);
});

test('latestTick in Europe/London across the spring-forward gap', () => {
  const c = parseCron('30 1 * * *');
  const tz = 'Europe/London';
  assert.equal(latestTick(c, new Date('2026-03-28T23:00Z'), new Date('2026-03-29T22:00Z'), tz), undefined);
  assert.equal(
    latestTick(c, new Date('2026-03-28T00:00Z'), new Date('2026-03-28T23:00Z'), tz)?.key,
    '2026-03-28T01:30',
  );
});

test('a fall-back duplicate hour fires once', () => {
  const c = parseCron('30 1 * * *');
  const tz = 'America/New_York';
  const edt = wallClock(new Date('2026-11-01T05:30Z'), tz);
  const est = wallClock(new Date('2026-11-01T06:30Z'), tz);
  assert.equal(edt.key, '2026-11-01T01:30');
  assert.equal(est.key, edt.key);
  assert.deepEqual(latestTick(c, new Date('2026-11-01T04:00Z'), new Date('2026-11-01T12:00Z'), tz), {
    at: new Date('2026-11-01T06:30Z'),
    key: '2026-11-01T01:30',
  });
});

test('an unknown time zone is reported', () => {
  assert.equal(knownTimeZone('Mars/Base'), false);
  assert.equal(knownTimeZone('Europe/London'), true);
});

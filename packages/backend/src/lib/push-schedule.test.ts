import { describe, expect, it } from 'vitest';
import {
  firstOccurrence,
  inQuietHours,
  isValidTimeZone,
  localParts,
  nextOccurrence,
  parseRule,
  quietHoursEnd,
  zonedTime,
} from './push-schedule.js';

const NY = 'America/New_York';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const NOW = Date.UTC(2026, 5, 1, 12, 0); // 2026-06-01T12:00Z

describe('parseRule', () => {
  it('accepts the three rule types', () => {
    const at = NOW + 60_000;
    expect(parseRule({ type: 'at', at }, NOW)).toEqual({ rule: { type: 'at', at } });
    expect(parseRule({ type: 'at', at: new Date(at).toISOString() }, NOW)).toEqual({
      rule: { type: 'at', at },
    });
    expect(parseRule({ type: 'daily', time: '07:30' }, NOW)).toEqual({
      rule: { type: 'daily', time: '07:30' },
    });
    expect(parseRule({ type: 'every', days: 3, time: '21:00' }, NOW)).toEqual({
      rule: { type: 'every', days: 3, time: '21:00' },
    });
  });

  it.each([
    ['a past one-shot', { type: 'at', at: NOW - 1 }],
    ['a one-shot more than a year out', { type: 'at', at: NOW + 400 * 86_400_000 }],
    ['a bad date', { type: 'at', at: 'not a date' }],
    ['a bad time', { type: 'daily', time: '24:00' }],
    ['a 12-hour time', { type: 'daily', time: '7:30' }],
    ['every 0 days', { type: 'every', days: 0, time: '09:00' }],
    ['fractional days', { type: 'every', days: 1.5, time: '09:00' }],
    ['an unknown type', { type: 'weekly', time: '09:00' }],
    ['a non-object', 'daily'],
  ])('rejects %s', (_name, input) => {
    expect(parseRule(input, NOW)).toHaveProperty('error');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects anything else', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe('zonedTime', () => {
  it('converts wall-clock times to instants in the zone', () => {
    expect(iso(zonedTime({ year: 2026, month: 6, day: 1 }, 9 * 60, NY))).toBe(
      '2026-06-01T13:00:00.000Z',
    );
    expect(iso(zonedTime({ year: 2026, month: 6, day: 1 }, 7 * 60 + 15, 'Asia/Kolkata'))).toBe(
      '2026-06-01T01:45:00.000Z',
    );
  });

  it('moves a time skipped by spring-forward to just after the jump', () => {
    // 2026-03-08 02:30 does not exist in New York; clocks go 02:00 → 03:00.
    const at = zonedTime({ year: 2026, month: 3, day: 8 }, 2 * 60 + 30, NY);
    expect(iso(at)).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
  });

  it('picks the first of a time repeated by fall-back', () => {
    // 2026-11-01 01:30 happens twice in New York; take the EDT one.
    expect(iso(zonedTime({ year: 2026, month: 11, day: 1 }, 90, NY))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });
});

describe('firstOccurrence', () => {
  it('fires a one-shot at its instant', () => {
    expect(firstOccurrence({ type: 'at', at: NOW + 5 }, NY, NOW)).toBe(NOW + 5);
  });

  it('fires a daily rule later today, or tomorrow if the time has passed', () => {
    // NOW is 08:00 in New York.
    expect(iso(firstOccurrence({ type: 'daily', time: '09:00' }, NY, NOW))).toBe(
      '2026-06-01T13:00:00.000Z',
    );
    expect(iso(firstOccurrence({ type: 'daily', time: '07:00' }, NY, NOW))).toBe(
      '2026-06-02T11:00:00.000Z',
    );
    expect(iso(firstOccurrence({ type: 'daily', time: '08:00' }, NY, NOW))).toBe(
      '2026-06-02T12:00:00.000Z',
    );
  });
});

describe('nextOccurrence', () => {
  it('returns null for one-shots', () => {
    expect(nextOccurrence({ type: 'at', at: NOW }, NY, NOW, NOW)).toBeNull();
  });

  it('keeps a daily reminder at 09:00 local across spring-forward', () => {
    const rule = { type: 'daily', time: '09:00' } as const;
    const sat = zonedTime({ year: 2026, month: 3, day: 7 }, 540, NY);
    expect(iso(sat)).toBe('2026-03-07T14:00:00.000Z'); // EST
    const sun = nextOccurrence(rule, NY, sat, sat) as number;
    expect(iso(sun)).toBe('2026-03-08T13:00:00.000Z'); // EDT: one hour earlier in UTC
    expect(localParts(sun, NY).minutes).toBe(540);
  });

  it('keeps a daily reminder at 09:00 local across fall-back', () => {
    const rule = { type: 'daily', time: '09:00' } as const;
    const sat = zonedTime({ year: 2026, month: 10, day: 31 }, 540, NY);
    expect(iso(sat)).toBe('2026-10-31T13:00:00.000Z'); // EDT
    expect(iso(nextOccurrence(rule, NY, sat, sat))).toBe('2026-11-01T14:00:00.000Z'); // EST
  });

  it('keeps a London reminder local across the UK change', () => {
    const rule = { type: 'daily', time: '08:00' } as const;
    const sat = zonedTime({ year: 2026, month: 3, day: 28 }, 480, 'Europe/London');
    expect(iso(sat)).toBe('2026-03-28T08:00:00.000Z'); // GMT
    expect(iso(nextOccurrence(rule, 'Europe/London', sat, sat))).toBe('2026-03-29T07:00:00.000Z'); // BST
  });

  it('steps every N days', () => {
    const prev = zonedTime({ year: 2026, month: 6, day: 1 }, 1260, NY);
    expect(iso(nextOccurrence({ type: 'every', days: 3, time: '21:00' }, NY, prev, prev))).toBe(
      '2026-06-05T01:00:00.000Z', // 2026-06-04 21:00 EDT
    );
  });

  it('skips occurrences already in the past instead of bursting catch-up pushes', () => {
    const prev = zonedTime({ year: 2026, month: 6, day: 1 }, 540, NY);
    const threeDaysLater = prev + 3 * 86_400_000 + 60_000;
    expect(iso(nextOccurrence({ type: 'daily', time: '09:00' }, NY, prev, threeDaysLater))).toBe(
      '2026-06-05T13:00:00.000Z',
    );
  });
});

describe('quiet hours', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 5, 1, h, m);

  it('handles a window that wraps midnight', () => {
    const start = 22 * 60;
    const end = 7 * 60;
    expect(inQuietHours(at(23), 'UTC', start, end)).toBe(true);
    expect(inQuietHours(at(3), 'UTC', start, end)).toBe(true);
    expect(inQuietHours(at(7), 'UTC', start, end)).toBe(false); // end is exclusive
    expect(inQuietHours(at(12), 'UTC', start, end)).toBe(false);
  });

  it('handles a same-day window and treats start == end as no window', () => {
    expect(inQuietHours(at(13), 'UTC', 12 * 60, 14 * 60)).toBe(true);
    expect(inQuietHours(at(14), 'UTC', 12 * 60, 14 * 60)).toBe(false);
    expect(inQuietHours(at(13), 'UTC', 600, 600)).toBe(false);
  });

  it('uses the schedule time zone', () => {
    // 03:00Z is 23:00 the previous evening in New York.
    expect(inQuietHours(at(3), NY, 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(at(3), 'UTC', 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(at(12), NY, 22 * 60, 7 * 60)).toBe(false); // 08:00 in New York
  });

  it('finds when the window ends', () => {
    expect(iso(quietHoursEnd(at(23), 'UTC', 7 * 60))).toBe('2026-06-02T07:00:00.000Z');
    expect(iso(quietHoursEnd(at(3), 'UTC', 7 * 60))).toBe('2026-06-01T07:00:00.000Z');
    expect(iso(quietHoursEnd(at(3), NY, 7 * 60))).toBe('2026-06-01T11:00:00.000Z'); // 07:00 EDT
  });
});

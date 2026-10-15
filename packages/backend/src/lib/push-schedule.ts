/**
 * Reminder rules for `fas.push` schedules (#146) and the time-zone arithmetic
 * behind them. Pure functions; the cron delivery and the routes share them.
 *
 * Deliberately small, not RRULE:
 *   { type: 'at', at }                  one-shot at an instant (ms since epoch)
 *   { type: 'daily', time: 'HH:MM' }    every day at a wall-clock time in tz
 *   { type: 'every', days, time }       every N days at a wall-clock time in tz
 *
 * Wall-clock times follow the schedule's IANA time zone, so a daily 09:00
 * stays 09:00 across DST changes. A time that doesn't exist on a
 * spring-forward day (02:30 in New York) fires at the shifted instant.
 */

export type PushRule =
  | { type: 'at'; at: number }
  | { type: 'daily'; time: string }
  | { type: 'every'; days: number; time: string };

export const MAX_EVERY_DAYS = 365;
/** One-shot reminders may be set at most this far ahead. */
export const MAX_AT_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' → minutes after midnight, or null. */
export function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = TIME_RE.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates an untrusted rule; returns it normalised, or an error message. */
export function parseRule(input: unknown, now: number): { rule: PushRule } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'rule must be an object' };
  const r = input as Record<string, unknown>;
  if (r.type === 'at') {
    const at = typeof r.at === 'string' ? Date.parse(r.at) : r.at;
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      return { error: 'rule.at must be a timestamp (ms) or an ISO date' };
    }
    if (at <= now) return { error: 'rule.at must be in the future' };
    if (at > now + MAX_AT_AHEAD_MS) return { error: 'rule.at must be within a year' };
    return { rule: { type: 'at', at } };
  }
  if (r.type === 'daily' || r.type === 'every') {
    if (parseTime(r.time) === null) return { error: 'rule.time must be HH:MM (24-hour)' };
    if (r.type === 'daily') return { rule: { type: 'daily', time: r.time as string } };
    const days = r.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_EVERY_DAYS) {
      return { error: `rule.days must be a whole number from 1 to ${MAX_EVERY_DAYS}` };
    }
    return { rule: { type: 'every', days, time: r.time as string } };
  }
  return { error: "rule.type must be 'at', 'daily' or 'every'" };
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in tz. */
export function localParts(ms: number, tz: string) {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
    minutes: (parts.hour as number) * 60 + (parts.minute as number),
    second: parts.second as number,
  };
}

/** tz's UTC offset at an instant, in ms (positive east of UTC). */
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    Math.floor(p.minutes / 60),
    p.minutes % 60,
    p.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which it is `minutes` past midnight on `date` in tz. For a
 * wall-clock time skipped by a DST jump, returns the instant the clocks
 * jumped to (e.g. 02:30 → 03:30 in New York's spring-forward hour).
 */
export function zonedTime(date: LocalDate, minutes: number, tz: string): number {
  const naive = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    Math.floor(minutes / 60),
    minutes % 60,
  );
  const first = naive - offsetAt(naive, tz);
  const second = naive - offsetAt(first, tz);
  // In a spring-forward gap the second guess lands on the wall clock just
  // before the jump (01:30 for 02:30); the first is the instant after it.
  return localParts(second, tz).minutes === minutes ? second : first;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function localDate(ms: number, tz: string): LocalDate {
  const p = localParts(ms, tz);
  return { year: p.year, month: p.month, day: p.day };
}

/** When a newly saved schedule should first fire (strictly after `now`). */
export function firstOccurrence(rule: PushRule, tz: string, now: number): number {
  if (rule.type === 'at') return rule.at;
  const minutes = parseTime(rule.time) as number;
  let date = localDate(now, tz);
  let at = zonedTime(date, minutes, tz);
  while (at <= now) {
    date = addDays(date, 1);
    at = zonedTime(date, minutes, tz);
  }
  return at;
}

/**
 * The next occurrence of a repeating rule after one that was due at
 * `previous`, skipping any that are already in the past at `now` (a missed
 * tick never produces a burst of catch-up pushes). Null for one-shot rules.
 */
export function nextOccurrence(
  rule: PushRule,
  tz: string,
  previous: number,
  now: number,
): number | null {
  if (rule.type === 'at') return null;
  const minutes = parseTime(rule.time) as number;
  const step = rule.type === 'daily' ? 1 : rule.days;
  let date = localDate(previous, tz);
  let at: number;
  do {
    date = addDays(date, step);
    at = zonedTime(date, minutes, tz);
  } while (at <= now);
  return at;
}

/** Whether `ms` falls inside the daily quiet window [start, end) in tz. The window may wrap midnight. */
export function inQuietHours(ms: number, tz: string, start: number, end: number): boolean {
  if (start === end) return false;
  const m = localParts(ms, tz).minutes;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** The first instant at or after `ms` when the quiet window [start, end) ends. */
export function quietHoursEnd(ms: number, tz: string, end: number): number {
  let date = localDate(ms, tz);
  let at = zonedTime(date, end, tz);
  while (at <= ms) {
    date = addDays(date, 1);
    at = zonedTime(date, end, tz);
  }
  return at;
}

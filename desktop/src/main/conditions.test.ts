import { describe, expect, it } from 'vitest';
import {
  contributeHold,
  contributeWhen,
  cpuThreads,
  DEFAULT_WHEN,
  finishes,
  holdReason,
  type Machine,
  OFF,
  restMs,
  usage,
  within,
} from './conditions.js';
import type { HistoryItem } from './history.js';

/** On AC power, cool, not in use, at noon, nothing done today: nothing holds. */
const machine: Machine = {
  onBattery: false,
  battery: null,
  thermal: null,
  speedLimit: null,
  inUse: false,
  minuteOfDay: 12 * 60,
  jobsToday: 0,
  msToday: 0,
};
const hold = (m: Partial<Machine>, w = {}) =>
  contributeHold('auto', { ...DEFAULT_WHEN, ...w }, { ...machine, ...m })?.text ?? null;

describe('Contribute conditions (#830)', () => {
  it('defaults never surprise: AC only, 40% floor, pause when hot or in use, Balanced', () => {
    expect(DEFAULT_WHEN).toEqual({
      onBattery: false,
      minBattery: 40,
      thermalPause: true,
      inUse: 'pause',
      cpu: 'balanced',
      dailyJobs: 0,
      dailyMinutes: 0,
      quietHours: false,
      quietFrom: 22 * 60,
      quietTo: 7 * 60,
    });
    expect(hold({})).toBeNull();
  });

  it('Off always holds, with its explicit copy', () => {
    expect(contributeHold('off', DEFAULT_WHEN, machine)).toEqual({ code: 'off', text: OFF });
    expect(OFF).toBe('Contribute is off. It will not start again until you turn it on.');
  });

  it('power: AC only, or on battery down to the minimum; no battery counts as AC', () => {
    expect(hold({ onBattery: true, battery: 90 })).toBe('On battery. It runs on AC power only.');
    expect(hold({ onBattery: true, battery: 28 }, { onBattery: true })).toBe(
      'Battery 28% (min 40%).',
    );
    expect(hold({ onBattery: true, battery: 40 }, { onBattery: true })).toBeNull();
    // Level unknown: allowed on battery, so it runs
    expect(hold({ onBattery: true, battery: null }, { onBattery: true })).toBeNull();
    expect(hold({ onBattery: false, battery: 5 })).toBeNull();
  });

  it('heat: macOS serious or critical, or a CPU speed limit below 100%; unless turned off', () => {
    expect(hold({ thermal: 'fair' })).toBeNull();
    expect(hold({ thermal: 'serious' })).toBe('The computer is hot.');
    expect(hold({ thermal: 'critical' })).toBe('The computer is hot.');
    expect(hold({ speedLimit: 100 })).toBeNull();
    expect(hold({ speedLimit: 70 })).toBe('The computer is hot.');
    expect(hold({ thermal: 'critical' }, { thermalPause: false })).toBeNull();
  });

  it('in use: pauses, or runs slower', () => {
    expect(hold({ inUse: true })).toBe('Computer in use.');
    expect(hold({ inUse: true }, { inUse: 'slower' })).toBeNull();
  });

  it('daily maximums of jobs and minutes, none by default', () => {
    expect(hold({ jobsToday: 500, msToday: 10 * 3600_000 })).toBeNull();
    expect(hold({ jobsToday: 20 }, { dailyJobs: 20 })).toBe('Daily maximum reached: 20 jobs.');
    expect(hold({ jobsToday: 19 }, { dailyJobs: 20 })).toBeNull();
    expect(hold({ msToday: 60 * 60_000 }, { dailyMinutes: 60 })).toBe(
      'Daily maximum reached: 60 min.',
    );
  });

  it('quiet hours, also across midnight', () => {
    const quiet = { quietHours: true };
    expect(hold({ minuteOfDay: 23 * 60 }, quiet)).toBe('Quiet hours until 07:00.');
    expect(hold({ minuteOfDay: 6 * 60 + 59 }, quiet)).toBe('Quiet hours until 07:00.');
    expect(hold({ minuteOfDay: 7 * 60 }, quiet)).toBeNull();
    expect(hold({ minuteOfDay: 23 * 60 })).toBeNull();
    expect(within(13 * 60, 12 * 60, 14 * 60 + 30)).toBe(true);
    expect(within(14 * 60 + 30, 12 * 60, 14 * 60 + 30)).toBe(false);
  });

  it('names the first condition that fails', () => {
    expect(hold({ onBattery: true, thermal: 'critical', inUse: true })).toBe(
      'On battery. It runs on AC power only.',
    );
    expect(hold({ thermal: 'critical', inUse: true })).toBe('The computer is hot.');
  });

  it('gives a stopped job back with an interrupted end reason', () => {
    const reason = (m: Partial<Machine>, w = {}) =>
      holdReason(contributeHold('auto', { ...DEFAULT_WHEN, ...w }, { ...machine, ...m })!);
    expect(reason({ onBattery: true })).toBe('unplugged');
    expect(reason({ onBattery: true, battery: 10 }, { onBattery: true })).toBe('unplugged');
    expect(reason({ thermal: 'serious' })).toBe('thermal');
    expect(reason({ inUse: true })).toBe('user_stop');
    expect(reason({ jobsToday: 1 }, { dailyJobs: 1 })).toBe('user_stop');
    expect(holdReason(contributeHold('off', DEFAULT_WHEN, machine)!)).toBe('user_stop');
  });

  it('finishes a job at least 80% done', () => {
    expect(finishes(4, 5)).toBe(true);
    expect(finishes(3, 5)).toBe(false);
    expect(finishes(0, 0)).toBe(false);
  });

  it('CPU: threads and rests between sentences, longer while in use and Run slower', () => {
    expect([cpuThreads('light', 8), cpuThreads('balanced', 8), cpuThreads('full', 8)]).toEqual([
      1, 2, 4,
    ]);
    expect(cpuThreads('full', 2)).toBe(2);
    expect(cpuThreads('balanced', 1)).toBe(1);
    expect([restMs(800, 'light', false), restMs(800, 'balanced', false)]).toEqual([800, 200]);
    expect(restMs(800, 'full', false)).toBe(0);
    expect(restMs(800, 'full', true)).toBe(800);
  });

  it('reads saved or sent conditions, keeping defaults for what is missing or wrong', () => {
    expect(contributeWhen(undefined)).toEqual(DEFAULT_WHEN);
    expect(contributeWhen('garbage')).toEqual(DEFAULT_WHEN);
    expect(
      contributeWhen({
        onBattery: true,
        minBattery: 250,
        thermalPause: 'no',
        inUse: 'sometimes',
        cpu: 'turbo',
        dailyJobs: -3,
        dailyMinutes: 30.4,
        quietFrom: 9999,
      }),
    ).toEqual({
      ...DEFAULT_WHEN,
      onBattery: true,
      minBattery: 100,
      dailyJobs: 0,
      dailyMinutes: 30,
      quietFrom: 24 * 60 - 1,
    });
  });

  it("counts today's uploads and time from the history, the job in hand included", () => {
    const now = new Date(2026, 10, 28, 15, 0);
    const today = new Date(2026, 10, 28, 9, 0).getTime();
    const item = (at: number, outcome: HistoryItem['outcome'], wallMs?: number) =>
      ({ at, outcome, record: { runner: 'desktop', reason: 'submitted', wallMs } }) as HistoryItem;
    expect(
      usage(
        [
          item(now.getTime() - 60_000, 'in_progress'),
          item(today, 'submitted', 120_000),
          item(today, 'stopped', 30_000),
          item(new Date(2026, 10, 27, 23, 0).getTime(), 'submitted', 999_000),
        ],
        now,
      ),
    ).toEqual({ jobsToday: 1, msToday: 210_000 });
  });
});

import { availableParallelism } from 'node:os';
import type { GenerationEndReason } from '@freeappstore/sdk';
import type { HistoryItem } from './history.js';

/**
 * When Contribute runs on this computer (#830), all decided here: the server sets no per-user
 * limits. The phones' model (android `ContributeConditions.kt`, ios `ContributeConditions.swift`)
 * adapted to a computer. Off is the hard stop; otherwise it runs by itself whenever every
 * condition holds (Auto). Defaults never surprise: AC power only, a 40% floor when battery is
 * allowed, a pause when hot or while the computer is in use, Balanced CPU, no daily maximum, no
 * quiet hours. A metered connection can't be told on a computer, so there is no data condition.
 */
export type ContributeMode = 'auto' | 'off';
export type Cpu = 'light' | 'balanced' | 'full';

export interface ContributeWhen {
  /** Also run on battery, at or above `minBattery` percent. */
  onBattery: boolean;
  minBattery: number;
  /** Pause while the computer is hot. */
  thermalPause: boolean;
  /** While the computer is in use: pause, or run with rests at least as long as each sentence. */
  inUse: 'pause' | 'slower';
  cpu: Cpu;
  /** 0: no maximum. */
  dailyJobs: number;
  dailyMinutes: number;
  /** Minutes of the day; the window may wrap midnight. */
  quietHours: boolean;
  quietFrom: number;
  quietTo: number;
}

export const DEFAULT_WHEN: ContributeWhen = {
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
};

/** sherpa-onnx threads, and a rest after each sentence as a share of the time it took (the phones'). */
export const CPU: Record<Cpu, { label: string; threads: number; rest: number }> = {
  light: { label: 'Light', threads: 1, rest: 1 },
  balanced: { label: 'Balanced', threads: 2, rest: 0.25 },
  full: { label: 'Full', threads: 4, rest: 0 },
};

/** Threads for `cpu`, never more than this computer has. */
export const cpuThreads = (cpu: Cpu, cores = availableParallelism()) =>
  Math.max(1, Math.min(CPU[cpu].threads, cores));

const int = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

/** `value` as conditions: what is missing or wrong keeps its default (saved settings, the window's changes). */
export function contributeWhen(value: unknown): ContributeWhen {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<string, unknown>>;
  const d = DEFAULT_WHEN;
  const bool = (x: unknown, fallback: boolean) => (typeof x === 'boolean' ? x : fallback);
  return {
    onBattery: bool(v.onBattery, d.onBattery),
    minBattery: int(v.minBattery, d.minBattery, 5, 100),
    thermalPause: bool(v.thermalPause, d.thermalPause),
    inUse: v.inUse === 'slower' || v.inUse === 'pause' ? v.inUse : d.inUse,
    cpu: typeof v.cpu === 'string' && v.cpu in CPU ? (v.cpu as Cpu) : d.cpu,
    dailyJobs: int(v.dailyJobs, d.dailyJobs, 0, 10_000),
    dailyMinutes: int(v.dailyMinutes, d.dailyMinutes, 0, 24 * 60),
    quietHours: bool(v.quietHours, d.quietHours),
    quietFrom: int(v.quietFrom, d.quietFrom, 0, 24 * 60 - 1),
    quietTo: int(v.quietTo, d.quietTo, 0, 24 * 60 - 1),
  };
}

/** What this computer is doing now, as `contributeHold` needs it. */
export interface Machine {
  /** Running on battery; a computer without one never is. */
  onBattery: boolean;
  /** 0-100, null when unknown. */
  battery: number | null;
  /** macOS thermal state (`nominal` … `critical`), null elsewhere. */
  thermal: string | null;
  /** The CPU speed limit the OS advertises, percent (below 100: throttled for heat); null until told. */
  speedLimit: number | null;
  /** A key or the mouse was touched in the last IDLE_SECONDS, and the screen is not locked. */
  inUse: boolean;
  /** Minutes since local midnight. */
  minuteOfDay: number;
  /** Jobs uploaded today and time worked today (`usage`). */
  jobsToday: number;
  msToday: number;
}

/** No key or mouse for this long and the computer is not in use. */
export const IDLE_SECONDS = 120;
/** A job this far through when a condition fails is finished; anything less is stopped and given back. */
export const NEARLY_DONE = 0.8;
export const OFF = 'Contribute is off. It will not start again until you turn it on.';

/** Why Contribute is not running now: `code` for the record, `text` for the status. */
export interface Hold {
  code: 'off' | 'quiet_hours' | 'daily_max' | 'unplugged' | 'battery' | 'thermal' | 'in_use';
  text: string;
}

export const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** Whether `minute` is in the window from `from` to `to` (minutes of the day), which may wrap midnight. */
export const within = (minute: number, from: number, to: number) =>
  from <= to ? minute >= from && minute < to : minute >= from || minute < to;

const hot = (m: Machine) =>
  m.thermal === 'serious' ||
  m.thermal === 'critical' ||
  (m.speedLimit !== null && m.speedLimit < 100);

/** The first condition that fails, or null when Contribute may run (Auto). */
export function contributeHold(mode: ContributeMode, w: ContributeWhen, m: Machine): Hold | null {
  if (mode === 'off') return { code: 'off', text: OFF };
  if (w.quietHours && within(m.minuteOfDay, w.quietFrom, w.quietTo))
    return { code: 'quiet_hours', text: `Quiet hours until ${clock(w.quietTo)}.` };
  if (w.dailyJobs > 0 && m.jobsToday >= w.dailyJobs)
    return { code: 'daily_max', text: `Daily maximum reached: ${w.dailyJobs} jobs.` };
  if (w.dailyMinutes > 0 && m.msToday >= w.dailyMinutes * 60_000)
    return { code: 'daily_max', text: `Daily maximum reached: ${w.dailyMinutes} min.` };
  if (m.onBattery && !w.onBattery)
    return { code: 'unplugged', text: 'On battery. It runs on AC power only.' };
  if (m.onBattery && m.battery !== null && m.battery < w.minBattery)
    return { code: 'battery', text: `Battery ${m.battery}% (min ${w.minBattery}%).` };
  if (w.thermalPause && hot(m)) return { code: 'thermal', text: 'The computer is hot.' };
  if (m.inUse && w.inUse === 'pause') return { code: 'in_use', text: 'Computer in use.' };
  return null;
}

/**
 * The #813 end reason of a job `hold` stopped part-way. Each is an interruption to the server
 * (#841), so the job is given back rather than lost.
 */
export function holdReason(hold: Hold): GenerationEndReason {
  if (hold.code === 'unplugged' || hold.code === 'battery') return 'unplugged';
  if (hold.code === 'thermal') return 'thermal';
  return 'user_stop';
}

/** Whether a job `sentence` of `sentences` through finishes despite a failed condition. */
export const finishes = (sentence: number, sentences: number) =>
  sentences > 0 && sentence / sentences >= NEARLY_DONE;

/** The rest after a sentence that took `ms`: the CPU setting's, at least as long as the sentence when `slower`. */
export const restMs = (ms: number, cpu: Cpu, slower: boolean) =>
  Math.round(ms * Math.max(CPU[cpu].rest, slower ? 1 : 0));

/** Jobs uploaded today, and time spent on today's attempts (the one in hand until `now`), from the history. */
export function usage(items: HistoryItem[], now: Date): { jobsToday: number; msToday: number } {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const today = items.filter((i) => i.at >= midnight);
  return {
    jobsToday: today.filter((i) => i.outcome === 'submitted').length,
    msToday: today.reduce(
      (ms, i) => ms + (i.outcome === 'in_progress' ? now.getTime() - i.at : (i.record.wallMs ?? 0)),
      0,
    ),
  };
}

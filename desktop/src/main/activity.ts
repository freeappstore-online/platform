import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from './hub.js';

export const MAX_ACTIVITY = 1000;
const FILE = 'ai-activity.json';
const MAX_FILE_BYTES = 1024 * 1024;
const name = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Persist call metadata only. Tool arguments, results and app-supplied error text never enter this file. */
export function activityEntries(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid activity file.');
  const seen = new Set<number>();
  return value
    .flatMap((item): LogEntry[] => {
      if (
        !item ||
        !Number.isSafeInteger(item.id) ||
        item.id < 1 ||
        seen.has(item.id) ||
        !Number.isFinite(item.at) ||
        item.at < 0 ||
        item.at > 8640000000000000 ||
        !name(item.tool, 64) ||
        typeof item.ok !== 'boolean' ||
        (item.appId !== undefined && !name(item.appId, 63)) ||
        (item.appTool !== undefined && !name(item.appTool, 64))
      )
        return [];
      seen.add(item.id);
      return [
        {
          id: item.id,
          at: item.at,
          tool: item.tool,
          ok: item.ok,
          ...(item.appId !== undefined && { appId: item.appId }),
          ...(item.appTool !== undefined && { appTool: item.appTool }),
        },
      ];
    })
    .sort((a, b) => b.at - a.at || b.id - a.id)
    .slice(0, MAX_ACTIVITY);
}

export function loadActivity(dir: string): { entries: LogEntry[]; error: string | null } {
  const path = join(dir, FILE);
  try {
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error('Activity file too large.');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved.version !== 1) throw new Error('Unknown activity format.');
    return { entries: activityEntries(saved.entries), error: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], error: null };
    return {
      entries: [],
      error: 'Saved AI activity could not be read. Clear history to start a new local record.',
    };
  }
}

export function saveActivity(dir: string, entries: LogEntry[]): void {
  const path = join(dir, FILE);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, entries: activityEntries(entries) })}\n`, {
    mode: 0o600,
  });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

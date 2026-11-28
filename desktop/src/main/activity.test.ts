import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activityEntries, loadActivity, MAX_ACTIVITY, saveActivity } from './activity.js';
import { Hub } from './hub.js';

const dirs: string[] = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'fas-activity-'));
  dirs.push(path);
  return path;
};
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('local AI activity', () => {
  it('restores after restart from userData, without saving call contents or error text', () => {
    const path = dir();
    const first = new Hub();
    first.record({
      tool: 'app_call',
      appId: 'books',
      appTool: 'read',
      ok: false,
      error: 'private input in an app error',
    });
    saveActivity(path, first.log);
    const second = new Hub();
    second.restoreLog(loadActivity(path).entries);
    expect(second.log).toEqual([
      expect.objectContaining({ tool: 'app_call', appId: 'books', ok: false }),
    ]);
    expect(second.log[0]).not.toHaveProperty('error');
    expect(readFileSync(join(path, 'ai-activity.json'), 'utf8')).not.toContain('private input');
    second.record({ tool: 'list_open_apps', ok: true });
    expect(second.log[0]!.id).toBeGreaterThan(second.log[1]!.id);
    if (process.platform !== 'win32')
      expect(statSync(join(path, 'ai-activity.json')).mode & 0o777).toBe(0o600);
  });
  it('keeps the latest 1,000 records and clears them durably', () => {
    const path = dir();
    const entries = Array.from({ length: MAX_ACTIVITY + 10 }, (_, id) => ({
      id: id + 1,
      at: id,
      tool: 'app_tools',
      ok: true,
    }));
    saveActivity(path, entries);
    expect(loadActivity(path).entries).toHaveLength(MAX_ACTIVITY);
    expect(loadActivity(path).entries[0]!.id).toBe(MAX_ACTIVITY + 10);
    const hub = new Hub();
    hub.restoreLog(loadActivity(path).entries);
    hub.clearLog();
    saveActivity(path, hub.log);
    expect(loadActivity(path).entries).toEqual([]);
  });
  it('reports corrupt or unknown files, tolerates missing history, and discards invalid rows', () => {
    const path = dir();
    expect(loadActivity(path)).toEqual({ entries: [], error: null });
    for (const content of ['broken', '{"version":2}', '{"version":1,"entries":{}}']) {
      writeFileSync(join(path, 'ai-activity.json'), content);
      expect(loadActivity(path).error).toContain('could not be read');
    }
    const row = { id: 1, at: 1, tool: 'app_call', ok: true, token: 'not saved' };
    expect(activityEntries([row, row, { ...row, id: -1 }])).toEqual([
      { id: 1, at: 1, tool: 'app_call', ok: true },
    ]);
  });
});

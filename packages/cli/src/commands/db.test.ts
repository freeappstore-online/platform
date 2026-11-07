import { describe, expect, it } from 'vitest';
import { dbCommand } from './db.js';

describe('dbCommand wiring (#467)', () => {
  it('exposes share, unshare and list', () => {
    expect(dbCommand.commands.map((c) => c.name()).sort()).toEqual(['list', 'share', 'unshare']);
  });

  it('takes the collection name and an optional --app', () => {
    for (const name of ['share', 'unshare']) {
      const cmd = dbCommand.commands.find((c) => c.name() === name)!;
      expect(cmd.registeredArguments.map((a) => a.name())).toEqual(['collection']);
      expect(cmd.options.map((o) => o.long)).toContain('--app');
    }
  });
});

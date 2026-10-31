import { runChecks } from '@freeappstore/compliance';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCommand } from './check.js';

vi.mock('@freeappstore/compliance', () => ({ runChecks: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('fas check --json', () => {
  it.each(['warn', 'fail'] as const)(
    'prints valid JSON and preserves %s exit semantics',
    async (status) => {
      const results = [{ name: 'Opaque surfaces', status, detail: '--panel: rgba(0,0,0,.8)' }];
      vi.mocked(runChecks).mockResolvedValue(results);
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await checkCommand.parseAsync(['--dir', 'fixture', '--json'], { from: 'user' });
      expect(runChecks).toHaveBeenCalledWith('fixture');
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual(results);
      expect(process.exitCode ?? 0).toBe(status === 'fail' ? 1 : 0);
    },
  );
});

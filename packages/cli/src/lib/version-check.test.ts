import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestVersion } from './version-check.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchLatestVersion', () => {
  it('clears the abort timer when the registry request fails', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(fetchLatestVersion()).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the published version and clears the timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '1.2.3' }),
      }),
    );

    await expect(fetchLatestVersion()).resolves.toBe('1.2.3');
    expect(vi.getTimerCount()).toBe(0);
  });
});

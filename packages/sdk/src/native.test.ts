import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.js';
import { Native } from './native.js';

function fakeAuth(token: string | null): Auth {
  return { token, handleUnauthorized: vi.fn() } as unknown as Auth;
}
const mockFetch = (body: unknown, status = 200) => {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  globalThis.fetch = fn;
  return fn;
};
const point = (n: number) => ({
  id: `p${n}`,
  grantId: 'g',
  at: 1000 + n,
  lat: 1,
  lng: 2,
  accuracy: 5,
  cursorId: `g:p${n}`,
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('Native', () => {
  it('reads status with the app session', async () => {
    const fetch = mockFetch({ available: true, enabled: false, lastPointAt: null });
    const status = await new Native('run', 'https://api.example', fakeAuth('tok')).status();
    expect(status).toEqual({ available: true, enabled: false, lastPointAt: null });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe('https://api.example/v1/apps/run/native/status');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('pages locations with the composite cursor and hides internal ids', async () => {
    const fetch = mockFetch({ points: Array.from({ length: 500 }, (_, i) => point(i)) });
    const native = new Native('run', 'https://api.example', fakeAuth('tok'));
    const first = await native.locations();
    expect(first.points[0]).toEqual({ id: 'p0', at: 1000, lat: 1, lng: 2, accuracy: 5 });
    expect(first).toMatchObject({ cursor: { after: 1499, afterId: 'g:p499' }, more: true });

    mockFetch({ points: [point(500)] });
    const second = await native.locations(first.cursor);
    expect(second).toMatchObject({ cursor: { after: 1500, afterId: 'g:p500' }, more: false });
    mockFetch({ points: [] });
    expect((await native.locations(second.cursor)).cursor).toEqual(second.cursor);
    mockFetch({ points: [point(500)] });
    await native.locations(first.cursor);
    const url = new URL(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString(),
    );
    expect(url.searchParams.get('after')).toBe('1499');
    expect(url.searchParams.get('afterId')).toBe('g:p499');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requires a session and reports 401 to auth', async () => {
    await expect(new Native('run', 'https://x', fakeAuth(null)).status()).rejects.toThrow(
      'Not signed in.',
    );
    mockFetch({}, 401);
    const auth = fakeAuth('tok');
    await expect(new Native('run', 'https://x', auth).locations()).rejects.toThrow(
      'Not signed in.',
    );
    expect(auth.handleUnauthorized).toHaveBeenCalledWith('tok');
  });

  it('links to the app disclosure in the companion', () => {
    expect(new Native('run', 'https://x', fakeAuth(null)).setupUrl).toBe(
      'freeappstore://native/apps/run',
    );
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientHeaders, fetchProfile } from './device.js';

const me = {
  user: {
    id: 'gh:1',
    name: 'Alex',
    login: 'alex',
    provider: 'github',
    avatarUrl: null,
    email: null,
    roles: ['user', 'creator'],
    appCount: 3,
  },
  device: { id: 'd1', label: 'FreeAppStore desktop (Mac)', createdAt: 1, expiresAt: 2 },
  apps: [{ id: 'run' }],
};

describe('fetchProfile (#829)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the account and this computer from /native/me with the device credential', async () => {
    const fetch = vi.fn(async () => Response.json(me));
    vi.stubGlobal('fetch', fetch);
    const headers = clientHeaders('0.4.0 (57, abc1234)');
    expect(await fetchProfile('ndev_x', headers, 'https://api.test/v1')).toEqual({
      user: me.user,
      device: me.device,
    });
    // With this app's version and kind (#833)
    expect(fetch).toHaveBeenCalledWith('https://api.test/v1/native/me', {
      headers: {
        'X-FAS-App-Version': '0.4.0 (57, abc1234)',
        'X-FAS-Client': 'desktop',
        Authorization: 'Bearer ndev_x',
      },
    });
  });

  it('is null for a refused credential and throws on other failures', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    expect(await fetchProfile('ndev_x', {})).toBeNull();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
    await expect(fetchProfile('ndev_x', {})).rejects.toThrow('HTTP 503');
  });
});

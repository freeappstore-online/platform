import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keys } from './keys.js';

function fakeAuth(token: string | null) {
  return { token, handleUnauthorized: vi.fn() };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('Keys.status', () => {
  it('returns the configured providers', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ keys: [{ provider: 'openai' }] })),
      );
    globalThis.fetch = fetchMock;
    const keys = new Keys('a', 'https://api.example', fakeAuth('tok'));
    expect(await keys.has('openai')).toBe(true);
    expect(await keys.has('anthropic')).toBe(false);
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer tok');
  });

  it('returns [] when signed out, without a request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    expect(await new Keys('a', 'https://api.example', fakeAuth(null)).status()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops an expired session on 401 and returns []', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const auth = fakeAuth('tok');
    expect(await new Keys('a', 'https://api.example', auth).status()).toEqual([]);
    expect(auth.handleUnauthorized).toHaveBeenCalledWith('tok');
  });
});

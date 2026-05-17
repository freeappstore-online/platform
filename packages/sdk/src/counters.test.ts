import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.js';
import { Counters } from './counters.js';

function fakeAuth(token: string | null): Auth {
  return { token, handleUnauthorized: vi.fn() } as unknown as Auth;
}

beforeEach(() => {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ value: 0 }), { status: 200 }));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('Counters.list', () => {
  it('fetches all counters without auth', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ likes: 5, views: 100 }), { status: 200 }));
    const counters = new Counters('poll', 'https://api.example', fakeAuth(null));
    const result = await counters.list();
    expect(result).toEqual({ likes: 5, views: 100 });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString()).toContain(
      '/v1/apps/poll/counters',
    );
  });

  it('passes prefix query param', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const counters = new Counters('poll', 'https://api.example', fakeAuth(null));
    await counters.list({ prefix: 'vote:' });
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString();
    expect(url).toContain('prefix=vote%3A');
  });
});

describe('Counters.get', () => {
  it('returns the counter value', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ value: 42 }), { status: 200 }));
    const counters = new Counters('poll', 'https://api.example', fakeAuth(null));
    expect(await counters.get('likes')).toBe(42);
  });
});

describe('Counters.increment', () => {
  it('sends POST with auth and returns new value', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ value: 6 }), { status: 200 }));
    const counters = new Counters('poll', 'https://api.example', fakeAuth('tok'));
    const result = await counters.increment('likes', 1);
    expect(result).toBe(6);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.Authorization).toBe('Bearer tok');
  });

  it('throws when not signed in', async () => {
    const counters = new Counters('poll', 'https://api.example', fakeAuth(null));
    await expect(counters.increment('likes')).rejects.toThrow(/not signed in/i);
  });

  it('calls handleUnauthorized on 401', async () => {
    const auth = fakeAuth('expired');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const counters = new Counters('poll', 'https://api.example', auth);
    await expect(counters.increment('likes')).rejects.toThrow(/not signed in/i);
    expect(auth.handleUnauthorized).toHaveBeenCalled();
  });
});

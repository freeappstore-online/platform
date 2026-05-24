import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.js';
import { Friends } from './friends.js';

function fakeAuth(token: string | null): Auth {
  return { token, handleUnauthorized: vi.fn() } as unknown as Auth;
}

beforeEach(() => {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ friends: [] }), { status: 200 }));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('Friends.list', () => {
  it('returns empty when not signed in', async () => {
    const friends = new Friends('app1', 'https://api.example', fakeAuth(null));
    const result = await friends.list();
    expect(result).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fetches accepted friends by default', async () => {
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await friends.list();
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toBe('https://api.example/v1/friends');
  });

  it('passes status query param', async () => {
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await friends.list('pending_incoming');
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toBe('https://api.example/v1/friends?status=pending_incoming');
  });

  it('calls handleUnauthorized on 401', async () => {
    const auth = fakeAuth('tok');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const friends = new Friends('app1', 'https://api.example', auth);
    const result = await friends.list();
    expect(result).toEqual([]);
    expect(auth.handleUnauthorized).toHaveBeenCalled();
  });
});

describe('Friends.requests', () => {
  it('calls list with pending_incoming', async () => {
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await friends.requests();
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('status=pending_incoming');
  });
});

describe('Friends.request', () => {
  it('throws when not signed in', async () => {
    const friends = new Friends('app1', 'https://api.example', fakeAuth(null));
    await expect(friends.request('u2')).rejects.toThrow('Not signed in');
  });

  it('sends POST with userId', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending', autoAccepted: false }), { status: 200 }),
    );
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    const result = await friends.request('u2');
    expect(result.status).toBe('pending');
    expect(result.autoAccepted).toBe(false);

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/friends/request');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ userId: 'u2' });
  });

  it('throws error message from server on failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'already friends' }), { status: 409 }),
    );
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await expect(friends.request('u2')).rejects.toThrow('already friends');
  });
});

describe('Friends.respond', () => {
  it('sends PATCH with action', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await friends.respond('u2', 'accept');

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/friends/u2');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ action: 'accept' });
  });

  it('encodes userId in URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await friends.respond('gh:123', 'block');

    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toBe('https://api.example/v1/friends/gh%3A123');
  });
});

describe('Friends.remove', () => {
  it('sends DELETE', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await friends.remove('u2');

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/friends/u2');
    expect(opts.method).toBe('DELETE');
  });
});

describe('Friends.block', () => {
  it('delegates to respond with block action', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await friends.block('u2');

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(opts.body)).toEqual({ action: 'block' });
  });
});

describe('Friends.check', () => {
  it('returns none when not signed in', async () => {
    const friends = new Friends('app1', 'https://api.example', fakeAuth(null));
    const result = await friends.check('u2');
    expect(result).toBe('none');
  });

  it('returns status from API', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }),
    );
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    const result = await friends.check('u2');
    expect(result).toBe('accepted');
  });
});

describe('Friends.isFriend', () => {
  it('returns true when accepted', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'accepted' }), { status: 200 }),
    );
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    expect(await friends.isFriend('u2')).toBe(true);
  });

  it('returns false for other statuses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending_outgoing' }), { status: 200 }),
    );
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    expect(await friends.isFriend('u2')).toBe(false);
  });
});

describe('Friends.search', () => {
  it('returns empty when not signed in', async () => {
    const friends = new Friends('app1', 'https://api.example', fakeAuth(null));
    const result = await friends.search('alice');
    expect(result).toEqual([]);
  });

  it('encodes query in URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ users: [] }), { status: 200 }),
    );
    const friends = new Friends('app1', 'https://api.example', fakeAuth('tok'));
    await friends.search('test user');
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toBe('https://api.example/v1/friends/search?q=test%20user');
  });
});

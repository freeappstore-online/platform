import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth } from './auth.js';

interface FakeStorage {
  store: Map<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

interface FakeWindow {
  location: {
    href: string;
    hash: string;
    pathname: string;
    search: string;
    assign: (url: string) => void;
  };
  localStorage: FakeStorage;
  history: { replaceState: (state: unknown, title: string, url: string) => void };
}

function makeWindow(initial: { href: string; hash?: string }): {
  window: FakeWindow;
  assigns: string[];
  replaces: string[];
} {
  const url = new URL(initial.href);
  if (initial.hash) url.hash = initial.hash;
  const assigns: string[] = [];
  const replaces: string[] = [];
  const storage: FakeStorage = {
    store: new Map(),
    getItem: (k) => storage.store.get(k) ?? null,
    setItem: (k, v) => void storage.store.set(k, v),
    removeItem: (k) => void storage.store.delete(k),
  };
  return {
    window: {
      location: {
        href: url.toString(),
        hash: url.hash,
        pathname: url.pathname,
        search: url.search,
        assign: (u: string) => assigns.push(u),
      },
      localStorage: storage,
      history: {
        replaceState: (_s, _t, u) => replaces.push(u),
      },
    },
    assigns,
    replaces,
  };
}

beforeEach(() => {
  // happy-dom-style globals; we install per-test
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).history;
  delete (globalThis as Record<string, unknown>).fetch;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).history;
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('Auth.signIn', () => {
  it('strips the hash from return_to so the OAuth callback does not clobber app router state', () => {
    const { window, assigns } = makeWindow({
      href: 'https://app.freeappstore.online/dashboard?team=42#/settings/profile',
    });
    (globalThis as Record<string, unknown>).window = window;
    const auth = new Auth('demo', 'https://api.freeappstore.online');

    auth.signIn();

    expect(assigns).toHaveLength(1);
    const target = new URL(assigns[0]!);
    const returnTo = target.searchParams.get('return_to');
    expect(returnTo).toBe('https://app.freeappstore.online/dashboard?team=42');
    // No #/settings/profile carried into return_to.
    expect(returnTo).not.toContain('#');
  });

  it('still preserves pathname + querystring', () => {
    const { window, assigns } = makeWindow({ href: 'https://app.example/page?x=1' });
    (globalThis as Record<string, unknown>).window = window;
    const auth = new Auth('demo', 'https://api.example');
    auth.signIn();
    const returnTo = new URL(assigns[0]!).searchParams.get('return_to');
    expect(returnTo).toBe('https://app.example/page?x=1');
  });
});

describe('Auth.signInWithEmail', () => {
  it('POSTs to /v1/auth/email/start with email, appId, and hash-stripped returnTo', async () => {
    const { window } = makeWindow({
      href: 'https://app.freeappstore.online/?x=1#/route/state',
    });
    (globalThis as Record<string, unknown>).window = window;
    const mockFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = mockFetch;

    const auth = new Auth('demo', 'https://api.freeappstore.online');
    await auth.signInWithEmail('alice@example.com');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url.toString()).toBe('https://api.freeappstore.online/v1/auth/email/start');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.email).toBe('alice@example.com');
    expect(body.appId).toBe('demo');
    // Hash stripped so it doesn't get clobbered by the #fas_session= callback
    expect(body.returnTo).toBe('https://app.freeappstore.online/?x=1');
    expect(body.returnTo).not.toContain('#');
  });

  it('throws when the server returns non-ok', async () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    (globalThis as Record<string, unknown>).window = window;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('returnTo not allowed', { status: 400 }));

    const auth = new Auth('demo', 'https://api.example');
    await expect(auth.signInWithEmail('a@b.com')).rejects.toThrow(/Magic-link request failed: 400/);
  });
});

describe('Auth.signIn provider gate', () => {
  it("throws when called with provider='email' (use signInWithEmail)", () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    (globalThis as Record<string, unknown>).window = window;
    const auth = new Auth('demo', 'https://api.example');
    expect(() => auth.signIn('email')).toThrow(/signInWithEmail/);
  });
});

describe('Auth.init — hash handling', () => {
  it('clears the hash and stays signed out when the auth fetch fails (no crash, no stuck state)', async () => {
    const { window, replaces } = makeWindow({
      href: 'https://app.example/',
      hash: '#fas_session=bad-token',
    });
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).history = window.history;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));

    const auth = new Auth('demo', 'https://api.example');
    // init() no longer throws — it silently remains signed out.
    await auth.init();

    // The hash was cleared before the fetch, so reload won't retry.
    expect(replaces).toHaveLength(1);
    expect(replaces[0]).toBe('/');
    expect(auth.user).toBeNull();
  });

  it('captures session and clears hash on successful auth callback', async () => {
    const { window, replaces } = makeWindow({
      href: 'https://app.example/dashboard',
      hash: '#fas_session=good-token',
    });
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).history = window.history;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'gh:1', login: 'alice', avatarUrl: null, dateOfBirth: null }), {
        status: 200,
      }),
    );

    const auth = new Auth('demo', 'https://api.example');
    await auth.init();

    expect(auth.user?.login).toBe('alice');
    expect(auth.token).toBe('good-token');
    expect(window.localStorage.store.get('fas:session')).toContain('good-token');
    expect(replaces[0]).toBe('/dashboard');
  });

  it('is a no-op when no fas_session hash is present', async () => {
    const { window, replaces } = makeWindow({ href: 'https://app.example/' });
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).history = window.history;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const auth = new Auth('demo', 'https://api.example');
    await auth.init();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replaces).toHaveLength(0);
    expect(auth.user).toBeNull();
  });
});

describe('Auth — storage round-trip', () => {
  it('reads cached session from localStorage in the constructor', () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    window.localStorage.store.set(
      'fas:session',
      JSON.stringify({
        token: 'cached',
        user: { id: 'gh:7', login: 'returning-user', avatarUrl: null, dateOfBirth: null },
      }),
    );
    (globalThis as Record<string, unknown>).window = window;

    const auth = new Auth('demo', 'https://api.example');
    expect(auth.user?.login).toBe('returning-user');
    expect(auth.token).toBe('cached');
  });

  it('signOut clears storage and notifies listeners', () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    window.localStorage.store.set(
      'fas:session',
      JSON.stringify({
        token: 'cached',
        user: { id: 'gh:7', login: 'u', avatarUrl: null, dateOfBirth: null },
      }),
    );
    (globalThis as Record<string, unknown>).window = window;

    const auth = new Auth('demo', 'https://api.example');
    const seen: (unknown | null)[] = [];
    auth.onChange((u) => seen.push(u));

    auth.signOut();

    expect(auth.user).toBeNull();
    expect(window.localStorage.store.has('fas:session')).toBe(false);
    // onChange fires immediately with current user on subscribe, then null on signOut
    expect(seen).toEqual([{ id: 'gh:7', login: 'u', avatarUrl: null, dateOfBirth: null }, null]);
  });

  it('returns null when localStorage has corrupt JSON (does not crash)', () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    window.localStorage.store.set('fas:session', '{ not: json');
    (globalThis as Record<string, unknown>).window = window;

    const auth = new Auth('demo', 'https://api.example');
    expect(auth.user).toBeNull();
  });
});

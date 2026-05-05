import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Auth } from './auth.js';

interface FakeStorage {
  store: Map<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

interface FakeWindow {
  location: { href: string; hash: string; pathname: string; search: string; assign: (url: string) => void };
  localStorage: FakeStorage;
  history: { replaceState: (state: unknown, title: string, url: string) => void };
}

function makeWindow(initial: { href: string; hash?: string }): { window: FakeWindow; assigns: string[]; replaces: string[] } {
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
  delete (globalThis as Record<string, unknown>)['window'];
  delete (globalThis as Record<string, unknown>)['history'];
  delete (globalThis as Record<string, unknown>)['fetch'];
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['window'];
  delete (globalThis as Record<string, unknown>)['history'];
  delete (globalThis as Record<string, unknown>)['fetch'];
});

describe('Auth.signIn', () => {
  it('strips the hash from return_to so the OAuth callback does not clobber app router state', () => {
    const { window, assigns } = makeWindow({
      href: 'https://app.freeappstore.online/dashboard?team=42#/settings/profile',
    });
    (globalThis as Record<string, unknown>)['window'] = window;
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
    (globalThis as Record<string, unknown>)['window'] = window;
    const auth = new Auth('demo', 'https://api.example');
    auth.signIn();
    const returnTo = new URL(assigns[0]!).searchParams.get('return_to');
    expect(returnTo).toBe('https://app.example/page?x=1');
  });
});

describe('Auth.init — hash handling', () => {
  it('clears the hash even when the auth fetch fails (regression: no stuck state)', async () => {
    const { window, replaces } = makeWindow({
      href: 'https://app.example/',
      hash: '#fas_session=bad-token',
    });
    (globalThis as Record<string, unknown>)['window'] = window;
    (globalThis as Record<string, unknown>)['history'] = window.history;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));

    const auth = new Auth('demo', 'https://api.example');
    await expect(auth.init()).rejects.toThrow();

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
    (globalThis as Record<string, unknown>)['window'] = window;
    (globalThis as Record<string, unknown>)['history'] = window.history;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'gh:1', login: 'alice', avatarUrl: null }), {
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
    (globalThis as Record<string, unknown>)['window'] = window;
    (globalThis as Record<string, unknown>)['history'] = window.history;
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
        user: { id: 'gh:7', login: 'returning-user', avatarUrl: null },
      }),
    );
    (globalThis as Record<string, unknown>)['window'] = window;

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
        user: { id: 'gh:7', login: 'u', avatarUrl: null },
      }),
    );
    (globalThis as Record<string, unknown>)['window'] = window;

    const auth = new Auth('demo', 'https://api.example');
    const seen: (unknown | null)[] = [];
    auth.onChange((u) => seen.push(u));

    auth.signOut();

    expect(auth.user).toBeNull();
    expect(window.localStorage.store.has('fas:session')).toBe(false);
    expect(seen).toEqual([null]);
  });

  it('returns null when localStorage has corrupt JSON (does not crash)', () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    window.localStorage.store.set('fas:session', '{ not: json');
    (globalThis as Record<string, unknown>)['window'] = window;

    const auth = new Auth('demo', 'https://api.example');
    expect(auth.user).toBeNull();
  });
});

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
      new Response(
        JSON.stringify({ id: 'gh:1', login: 'alice', avatarUrl: null, dateOfBirth: null }),
        {
          status: 200,
        },
      ),
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

  it('signOut asks the platform to revoke every session, with the token it is dropping (#495)', () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    window.localStorage.store.set(
      'fas:session',
      JSON.stringify({
        token: 'cached',
        user: { id: 'gh:7', login: 'u', avatarUrl: null, dateOfBirth: null },
      }),
    );
    (globalThis as Record<string, unknown>).window = window;
    const fetch = vi.fn(() => Promise.resolve(new Response('{"ok":true}')));
    globalThis.fetch = fetch;

    new Auth('demo', 'https://api.example').signOut();

    // The constructor's ensure-member call is the other one.
    const logout = fetch.mock.calls.find(
      (call) => String((call as unknown as [URL])[0]) === 'https://api.example/v1/auth/logout',
    ) as unknown as [URL, RequestInit] | undefined;
    if (!logout) throw new Error('expected a /v1/auth/logout call');
    expect(logout[1].method).toBe('POST');
    expect((logout[1].headers as Record<string, string>).Authorization).toBe('Bearer cached');
  });

  it('signOut does not call the platform when there is no session', () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    (globalThis as Record<string, unknown>).window = window;
    const fetch = vi.fn();
    globalThis.fetch = fetch;

    new Auth('demo', 'https://api.example').signOut();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('deleteAccount sends the user to the console account settings (#495)', async () => {
    const { window, assigns } = makeWindow({ href: 'https://app.example/' });
    window.localStorage.store.set(
      'fas:session',
      JSON.stringify({
        token: 'cached',
        user: { id: 'gh:7', login: 'u', avatarUrl: null, dateOfBirth: null },
      }),
    );
    (globalThis as Record<string, unknown>).window = window;
    const fetch = vi.fn(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetch;

    const auth = new Auth('demo', 'https://api.example');
    await auth.deleteAccount();

    expect(assigns).toEqual(['https://freeappstore.online/app/settings?delete-account=1']);
    expect(
      fetch.mock.calls.some(
        (call) => (call as unknown as [URL, RequestInit])[1]?.method === 'DELETE',
      ),
    ).toBe(false);
    // The local session is untouched: the console does the deleting.
    expect(auth.token).toBe('cached');
  });

  it('returns null when localStorage has corrupt JSON (does not crash)', () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    window.localStorage.store.set('fas:session', '{ not: json');
    (globalThis as Record<string, unknown>).window = window;

    const auth = new Auth('demo', 'https://api.example');
    expect(auth.user).toBeNull();
  });
});

describe('Auth with storage blocked (SecurityError on access)', () => {
  function blockStorage(window: FakeWindow) {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  }

  it('constructs signed-out instead of throwing', () => {
    const { window } = makeWindow({ href: 'https://app.freeappstore.online/' });
    blockStorage(window);
    (globalThis as Record<string, unknown>).window = window;
    const auth = new Auth('demo', 'https://api.example');
    expect(auth.user).toBeNull();
  });

  it('signOut still notifies listeners', () => {
    const { window } = makeWindow({ href: 'https://app.freeappstore.online/' });
    blockStorage(window);
    (globalThis as Record<string, unknown>).window = window;
    const auth = new Auth('demo', 'https://api.example');
    const seen: unknown[] = [];
    auth.onChange((u) => seen.push(u));
    expect(() => auth.signOut()).not.toThrow();
    expect(seen).toContain(null);
  });
});

// A callback is shared by Shell, profile consumers, and StrictMode effect retries.
describe('Auth callback lifecycle (#340)', () => {
  function pendingCallback() {
    const { window } = makeWindow({ href: 'https://app.example/profile#fas_session=test-token' });
    window.history.replaceState = () => {
      window.location.hash = '';
    };
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).history = window.history;
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    globalThis.fetch = fetch;
    const auth = new Auth('demo', 'https://api.example');
    const finish = () =>
      resolve(
        new Response(
          JSON.stringify({ id: 'gh:1', login: 'alice', avatarUrl: null, dateOfBirth: null }),
        ),
      );
    return { auth, window, fetch, finish };
  }

  it('all init callers wait for the same pending callback', async () => {
    const { auth, finish } = pendingCallback();
    const first = auth.init();
    const ready = vi.fn();
    const second = auth.init().then(ready);
    await Promise.resolve();
    const completedEarly = ready.mock.calls.length;
    finish();
    await Promise.all([first, second]);
    expect(completedEarly).toBe(0);
    expect(auth.user?.login).toBe('alice');
  });

  it('does not restore a session after sign-out while callback verification is pending', async () => {
    const { auth, window, finish, fetch } = pendingCallback();
    const pending = auth.init();
    auth.signOut();
    finish();
    await pending;
    expect(auth.user).toBeNull();
    expect(auth.token).toBeNull();
    expect(window.localStorage.getItem('fas:session')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Auth protects the active session from stale requests (#350/#361)', () => {
  function storedSession(window: FakeWindow, token: string, login: string) {
    window.localStorage.setItem(
      'fas:session',
      JSON.stringify({
        token,
        user: { id: `id:${login}`, login, avatarUrl: null, dateOfBirth: null },
      }),
    );
  }

  it('does not let a delayed account A KV 401 sign out account B', async () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).history = window.history;
    storedSession(window, 'token-a', 'alice');
    const auth = new Auth('demo', 'https://api.example');
    let rejectA!: (response: Response) => void;
    let rejectCollectionA!: (response: Response) => void;
    let rejectProxyA!: (response: Response) => void;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/kv/draft'))
        return new Promise<Response>((resolve) => {
          rejectA = resolve;
        });
      if (String(input).includes('/db/notes'))
        return new Promise<Response>((resolve) => {
          rejectCollectionA = resolve;
        });
      if (String(input).includes('/proxy/'))
        return new Promise<Response>((resolve) => {
          rejectProxyA = resolve;
        });
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: 'id:bob', login: 'bob', avatarUrl: null, dateOfBirth: null }),
        ),
      );
    });
    const oldRequest = new (await import('./kv.js')).Kv('demo', 'https://api.example', auth).get(
      'draft',
    );
    const oldCollectionWrite = new (await import('./db.js')).Collections(
      'demo',
      'https://api.example',
      auth,
    )
      .collection('notes', { visibility: 'public-read' })
      .create({ text: 'synthetic' });
    const oldProxyRequest = new (await import('./proxy.js')).ApiProxy(
      'demo',
      'https://api.example',
      auth,
    ).fetch('example.test/data');
    const oldRequestResult = oldRequest.then(
      () => null,
      (error) => error,
    );
    const oldCollectionResult = oldCollectionWrite.then(
      () => null,
      (error) => error,
    );
    const oldProxyResult = oldProxyRequest.then(
      () => null,
      (error) => error,
    );
    auth.signOut();
    window.location.hash = '#fas_session=token-b';
    await auth.init();
    expect(auth.user?.login).toBe('bob');
    rejectA(new Response('', { status: 401 }));
    rejectCollectionA(new Response('', { status: 401 }));
    rejectProxyA(new Response('', { status: 401 }));
    expect(String(await oldRequestResult)).toMatch(/not signed in/i);
    expect(String(await oldCollectionResult)).toMatch(/not signed in/i);
    expect(String(await oldProxyResult)).toMatch(/unauthorized/i);
    expect(auth.user?.login).toBe('bob');
    expect(auth.token).toBe('token-b');
    expect(window.localStorage.getItem('fas:session')).toContain('token-b');
  });

  it('still invalidates the matching current session on a 401', async () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    (globalThis as Record<string, unknown>).window = window;
    storedSession(window, 'token-a', 'alice');
    const auth = new Auth('demo', 'https://api.example');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    await expect(
      new (await import('./kv.js')).Kv('demo', 'https://api.example', auth).get('draft'),
    ).rejects.toThrow(/not signed in/i);
    expect(auth.user).toBeNull();
    expect(auth.token).toBeNull();
    expect(window.localStorage.getItem('fas:session')).toBeNull();
  });

  it('keeps sign-out effective when a pending request later returns 401', async () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    (globalThis as Record<string, unknown>).window = window;
    storedSession(window, 'token-a', 'alice');
    const auth = new Auth('demo', 'https://api.example');
    let rejectRequest!: (response: Response) => void;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) =>
      // signOut()'s own logout call must not take the resolver meant for the KV request.
      String(input).endsWith('/v1/auth/logout')
        ? Promise.resolve(new Response('{"ok":true}'))
        : new Promise<Response>((resolve) => {
            rejectRequest = resolve;
          }),
    );
    const request = new (await import('./kv.js')).Kv('demo', 'https://api.example', auth).get(
      'draft',
    );
    auth.signOut();
    rejectRequest(new Response('', { status: 401 }));
    await expect(request).rejects.toThrow(/not signed in/i);
    expect(auth.user).toBeNull();
    expect(window.localStorage.getItem('fas:session')).toBeNull();
  });

  it('does not persist account A profile data over account B after a delayed success', async () => {
    const { window } = makeWindow({ href: 'https://app.example/' });
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).history = window.history;
    storedSession(window, 'token-a', 'alice');
    const auth = new Auth('demo', 'https://api.example');
    let finishA!: (response: Response) => void;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/date-of-birth'))
        return new Promise<Response>((resolve) => {
          finishA = resolve;
        });
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: 'id:bob', login: 'bob', avatarUrl: null, dateOfBirth: null }),
        ),
      );
    });
    const oldUpdate = auth.setDateOfBirth('1990-01-01');
    auth.signOut();
    window.location.hash = '#fas_session=token-b';
    await auth.init();
    finishA(
      new Response(
        JSON.stringify({
          id: 'id:alice',
          login: 'alice',
          avatarUrl: null,
          dateOfBirth: '1990-01-01',
        }),
      ),
    );
    await expect(oldUpdate).rejects.toThrow(/session changed/i);
    expect(auth.user?.login).toBe('bob');
    expect(auth.token).toBe('token-b');
    expect(window.localStorage.getItem('fas:session')).toContain('token-b');
  });
});

describe('Auth synchronizes same-origin tabs', () => {
  it('clears a stale account when another tab signs out from the shared session', () => {
    const sharedStorage: FakeStorage = {
      store: new Map([
        [
          'fas:session',
          JSON.stringify({
            token: 'token-a',
            user: { id: 'id:alice', login: 'alice', avatarUrl: null, dateOfBirth: null },
          }),
        ],
      ]),
      getItem: (key) => sharedStorage.store.get(key) ?? null,
      setItem: (key, value) => void sharedStorage.store.set(key, value),
      removeItem: (key) => void sharedStorage.store.delete(key),
    };
    const tabA = new EventTarget() as EventTarget & FakeWindow;
    const tabB = new EventTarget() as EventTarget & FakeWindow;
    for (const tab of [tabA, tabB]) {
      Object.assign(tab, {
        location: {
          href: 'https://app.example/',
          hash: '',
          pathname: '/',
          search: '',
          assign: () => undefined,
        },
        localStorage: sharedStorage,
        history: { replaceState: () => undefined },
      });
    }

    (globalThis as Record<string, unknown>).window = tabA;
    const authA = new Auth('demo', 'https://api.example');
    (globalThis as Record<string, unknown>).window = tabB;
    const authB = new Auth('demo', 'https://api.example');

    tabA.dispatchEvent(
      Object.assign(new Event('storage'), {
        key: 'unrelated',
        newValue: null,
        storageArea: sharedStorage,
      }),
    );
    tabA.dispatchEvent(
      Object.assign(new Event('storage'), {
        key: 'fas:session',
        newValue: null,
        storageArea: { ...sharedStorage },
      }),
    );
    expect(authA.user?.login).toBe('alice');

    authB.signOut();

    const storageEvent = Object.assign(new Event('storage'), {
      key: 'fas:session',
      newValue: null,
      storageArea: sharedStorage,
    });
    tabA.dispatchEvent(storageEvent);
    expect(authA.user).toBeNull();
    expect(authA.token).toBeNull();

    sharedStorage.setItem(
      'fas:session',
      JSON.stringify({
        token: 'token-b',
        user: { id: 'id:bob', login: 'bob', avatarUrl: null, dateOfBirth: null },
      }),
    );
    tabA.dispatchEvent(
      Object.assign(new Event('storage'), {
        key: 'fas:session',
        newValue: sharedStorage.getItem('fas:session'),
        storageArea: sharedStorage,
      }),
    );
    expect(authA.user?.login).toBe('bob');
    expect(authA.token).toBe('token-b');

    sharedStorage.store.clear();
    tabA.dispatchEvent(
      Object.assign(new Event('storage'), {
        key: null,
        newValue: null,
        storageArea: sharedStorage,
      }),
    );
    expect(authA.user).toBeNull();
  });
});

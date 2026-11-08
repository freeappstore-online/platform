import type { Unsubscribe, User } from './types.js';

export type AuthProvider = 'github' | 'google' | 'apple' | 'email';

/**
 * Shared by everything on this app's origin. The token inside is scoped to
 * this app (its `aud` claim): it works for this app's data and the user-level
 * routes, not for other apps or the console.
 */
const STORAGE_KEY = 'fas:session';
/** The value this browser sent at sign-in start; the API echoes it with the session (#564). */
const CLIENT_STATE_KEY = 'fas:auth-state';

/** This browser's pending sign-in value, created on first use. Null when storage is unavailable. */
function clientState(): string | null {
  try {
    let value = window.localStorage.getItem(CLIENT_STATE_KEY);
    if (!value) {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      window.localStorage.setItem(CLIENT_STATE_KEY, value);
    }
    return value;
  } catch {
    return null;
  }
}

/** Did this browser start the sign-in that delivered `state`? Consumes the pending value on a match. */
function claimClientState(state: string | null): boolean {
  try {
    if (!state || window.localStorage.getItem(CLIENT_STATE_KEY) !== state) return false;
    window.localStorage.removeItem(CLIENT_STATE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Where account-level actions that need a first-party session live. */
const CONSOLE_ACCOUNT_URL = 'https://freeappstore.online/app/settings';

interface Session {
  token: string;
  user: User;
}

/** OAuth authentication — sign in, sign out, session management. */
export class Auth {
  private session: Session | null = null;
  private listeners = new Set<(user: User | null) => void>();
  private initialization: Promise<void> | null = null;
  private sessionRevision = 0;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
  ) {
    this.session = this.readStorage();
    if (this.session) this.ensureMember();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', this.onStorage);
    }
  }

  /** Current signed-in user, or null if not authenticated. */
  get user(): User | null {
    return this.session?.user ?? null;
  }

  /** Current session token, or null if not authenticated. */
  get token(): string | null {
    return this.session?.token ?? null;
  }

  /** Subscribe to auth state changes. Fires immediately with current user, then on every change. */
  onChange(listener: (user: User | null) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.user);
    return () => this.listeners.delete(listener);
  }

  /**
   * Redirect-based GitHub OAuth. Opens the platform's hosted OAuth start URL,
   * which redirects back to the current page with a session token in the hash.
   *
   * The current page's `location.hash` is dropped from `return_to` because
   * the OAuth callback writes its own `#fas_session=…` and would clobber any
   * hash-based router state otherwise.
   */
  signIn(provider: AuthProvider = 'github'): void {
    if (typeof window === 'undefined') return;
    if (provider === 'email') {
      throw new Error('Use signInWithEmail(email) for email magic-link sign-in.');
    }
    const here = new URL(window.location.href);
    here.hash = '';
    const url = new URL(`/v1/auth/${provider}/start`, this.apiBase);
    url.searchParams.set('app_id', this.appId);
    url.searchParams.set('return_to', here.toString());
    const state = clientState();
    if (state) url.searchParams.set('client_state', state);
    window.location.assign(url.toString());
  }

  /**
   * Email magic-link sign-in. Sends the user an email with a one-time link
   * that completes auth and redirects back here with `#fas_session=…`.
   *
   * Resolves once the email has been queued. The caller should show a
   * "check your inbox" message — the actual sign-in happens later when
   * the user clicks the link.
   *
   * Throws on validation or server errors. Resolves with `{ ok: true }`
   * regardless of whether the email is already registered (no account-
   * enumeration leak).
   */
  async signInWithEmail(email: string): Promise<void> {
    if (typeof window === 'undefined') return;
    const here = new URL(window.location.href);
    here.hash = '';
    const state = clientState();
    const res = await fetch(new URL('/v1/auth/email/start', this.apiBase), {
      method: 'POST',
      // Lets the API set the cookie that binds the link to this browser: opened
      // here it signs in directly, elsewhere it asks the user to confirm.
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        appId: this.appId,
        returnTo: here.toString(),
        ...(state ? { clientState: state } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Magic-link request failed: ${res.status} ${body}`);
    }
  }

  /**
   * Sign out of this app: clear this app's session and notify listeners. The
   * token is scoped to this app, so this ends its access here. Ending every
   * session of the account ("sign out everywhere") is a console action.
   */
  signOut(): void {
    this.sessionRevision++;
    this.session = null;
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {}
    }
    this.emit();
  }

  /**
   * @internal Called by Kv and ApiProxy on 401 responses.
   * Clears the stale session so the UI reacts immediately.
   * Do not call directly — use `signOut()` instead.
   */
  handleUnauthorized(requestToken?: string): void {
    if (this.session && (!requestToken || this.session.token === requestToken)) this.signOut();
  }

  /**
   * Delete the account. Deletion (API keys, KV, friendships, roles, owned
   * documents, logs, then the account itself) needs a first-party session, so
   * this sends the user to the console's account settings, where the delete
   * button lives. An app-scoped session is not accepted for it.
   *
   * Not deleted: apps you own (deprovision those separately).
   */
  async deleteAccount(): Promise<void> {
    if (typeof window === 'undefined') return;
    window.location.assign(`${CONSOLE_ACCOUNT_URL}?delete-account=1`);
  }

  /**
   * Call this once at app start, before rendering anything that depends on
   * auth state. If the page was loaded via an auth callback (e.g. after
   * `signIn()` returned from GitHub), this captures the session from the
   * URL hash, persists it to localStorage, and clears the hash. On a normal
   * page load it's a no-op — the constructor already restored any cached
   * session from localStorage.
   * Concurrent callers wait for the same verification. Signing out while it
   * is pending prevents that callback from restoring the session afterward.
   *
   * @example
   *   const fas = initApp({ appId: 'my-app' });
   *   await fas.auth.init();
   *   render();
   */
  init(): Promise<void> {
    if (this.initialization) return this.initialization;
    const pending = this.consumeCallback();
    this.initialization = pending;
    const clear = () => {
      if (this.initialization === pending) this.initialization = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async consumeCallback(): Promise<void> {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash.startsWith('#fas_session=')) return;

    // Always clear the hash before doing anything else — even on failure.
    // Otherwise a bad token gets re-tried on every reload and the user is
    // permanently stuck on a "broken" URL.
    history.replaceState(null, '', window.location.pathname + window.location.search);

    const [rawToken = '', ...params] = hash.slice('#fas_session='.length).split('&');
    const state = new URLSearchParams(params.join('&')).get('fas_state');
    let token: string;
    try {
      token = decodeURIComponent(rawToken);
    } catch {
      // Malformed hash (% with nothing after, etc.). Hash already cleared.
      return;
    }
    if (!token) return;
    const startedHere = claimClientState(state);

    const revision = this.sessionRevision;
    try {
      const user = await this.fetchUser(token);
      // A sign-out during verification must win over this stale callback.
      if (revision !== this.sessionRevision) return;
      // A session this browser did not ask for may be someone else's account,
      // planted by a crafted link (#564). A magic link opened on another device
      // is the legitimate case, so the person decides, seeing whose account it is.
      if (!startedHere && !window.confirm(`Sign in as ${user.login}?`)) return;
      this.sessionRevision++;
      this.session = { token, user };
      // Emit/ensure BEFORE persisting: writeStorage() can throw in
      // storage-restricted contexts (private-mode webviews, disabled/full
      // localStorage). If it threw first, the in-memory session would be set but
      // listeners never notified — the UI stays signed-out with the hash already
      // cleared, stranding the user. A memory-only session is fine.
      this.emit();
      this.ensureMember();
      try {
        this.writeStorage(this.session);
      } catch {
        /* memory-only session; nothing more to do */
      }
    } catch {
      // Token was invalid or network failed. Hash already cleared so the user
      // won't get stuck in a retry loop. Silently remain signed out.
    }
  }

  /**
   * Set the user's platform-level date of birth. Set-once: throws if it's
   * already set (status 409 from the backend) or if age < 13. After success
   * the cached user is updated and listeners are notified.
   *
   * @param dateOfBirth ISO 'YYYY-MM-DD' string.
   */
  async setDateOfBirth(dateOfBirth: string): Promise<User> {
    const session = this.session;
    if (!session) throw new Error('Not signed in.');
    const { token } = session;
    const revision = this.sessionRevision;
    const response = await fetch(new URL('/v1/auth/me/date-of-birth', this.apiBase), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dateOfBirth }),
    });
    if (response.status === 401) {
      this.handleUnauthorized(token);
      throw new Error('Not signed in.');
    }
    if (response.status === 409) {
      throw new Error('Date of birth already set.');
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`setDateOfBirth failed (${response.status}): ${body}`);
    }
    const user = (await response.json()) as User;
    if (revision !== this.sessionRevision || this.session?.token !== token) {
      throw new Error('Session changed while updating profile. Please retry.');
    }
    this.session = { ...session, user };
    this.writeStorage(this.session);
    this.emit();
    return user;
  }

  private async fetchUser(token: string): Promise<User> {
    const response = await fetch(new URL('/v1/auth/me', this.apiBase), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
    return (await response.json()) as User;
  }

  /** Fire-and-forget: ensure the user has at least 'member' role in this app. */
  private ensureMember(): void {
    if (typeof fetch === 'undefined') return; // SSR / test env
    const t = this.session?.token;
    if (!t) return;
    fetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/roles/ensure-member`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}` },
    }).catch(() => {}); // silent — non-blocking
  }

  // Storage access throws SecurityError when site data is blocked or in a
  // sandboxed iframe, and setItem throws when full. A memory-only session is
  // fine, so none of these may throw.
  private readStorage(): Session | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  }

  private writeStorage(session: Session): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {}
  }

  private readonly onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }

    // Read the current value rather than replaying event.newValue: multiple
    // account changes can land before this tab handles its queued events.
    const previousToken = this.session?.token;
    this.sessionRevision++;
    this.session = this.readStorage();
    if (this.session && this.session.token !== previousToken) this.ensureMember();
    this.emit();
  };

  private emit(): void {
    for (const listener of this.listeners) listener(this.user);
  }
}

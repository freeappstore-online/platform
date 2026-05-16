import type { Unsubscribe, User } from "./types.js";

/**
 * Shared across all FAS apps on the same origin — this is intentional SSO.
 * A user signed in on one FAS app is signed in on all of them.
 */
const STORAGE_KEY = "fas:session";

interface Session {
  token: string;
  user: User;
}

/** GitHub OAuth authentication — sign in, sign out, session management. */
export class Auth {
  private session: Session | null = null;
  private listeners = new Set<(user: User | null) => void>();

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
  ) {
    this.session = this.readStorage();
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
  signIn(): void {
    const here = new URL(window.location.href);
    here.hash = "";
    const url = new URL("/v1/auth/github/start", this.apiBase);
    url.searchParams.set("app_id", this.appId);
    url.searchParams.set("return_to", here.toString());
    window.location.assign(url.toString());
  }

  /** Clear the session and notify listeners. */
  signOut(): void {
    this.session = null;
    window.localStorage.removeItem(STORAGE_KEY);
    this.emit();
  }

  /**
   * Called internally by Kv and ApiProxy when an API response returns 401.
   * Clears the stale session so the UI reacts (shows sign-in) instead of
   * every subsequent call throwing "Not signed in" from a cached dead token.
   */
  handleUnauthorized(): void {
    if (this.session) this.signOut();
  }

  /**
   * Call this once at app start, before rendering anything that depends on
   * auth state. If the page was loaded via an auth callback (e.g. after
   * `signIn()` returned from GitHub), this captures the session from the
   * URL hash, persists it to localStorage, and clears the hash. On a normal
   * page load it's a no-op — the constructor already restored any cached
   * session from localStorage.
   *
   * @example
   *   const fas = initApp({ appId: 'my-app' });
   *   await fas.auth.init();
   *   render();
   */
  async init(): Promise<void> {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash.startsWith("#fas_session=")) return;

    // Always clear the hash before doing anything else — even on failure.
    // Otherwise a bad token gets re-tried on every reload and the user is
    // permanently stuck on a "broken" URL.
    history.replaceState(null, "", window.location.pathname + window.location.search);

    let token: string;
    try {
      token = decodeURIComponent(hash.slice("#fas_session=".length));
    } catch {
      // Malformed hash (% with nothing after, etc.). Hash already cleared.
      return;
    }
    if (!token) return;

    try {
      const user = await this.fetchUser(token);
      this.session = { token, user };
      this.writeStorage(this.session);
      this.emit();
    } catch {
      // Token was invalid or network failed. Hash already cleared so the user
      // won't get stuck in a retry loop. Silently remain signed out.
    }
  }

  private async fetchUser(token: string): Promise<User> {
    const response = await fetch(new URL("/v1/auth/me", this.apiBase), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
    return (await response.json()) as User;
  }

  private readStorage(): Session | null {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  private writeStorage(session: Session): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.user);
  }
}

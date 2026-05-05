import type { User, Unsubscribe } from './types.js';

const STORAGE_KEY = 'fas:session';

interface Session {
  token: string;
  user: User;
}

export class Auth {
  private session: Session | null = null;
  private listeners = new Set<(user: User | null) => void>();

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
  ) {
    this.session = this.readStorage();
  }

  get user(): User | null {
    return this.session?.user ?? null;
  }

  get token(): string | null {
    return this.session?.token ?? null;
  }

  onChange(listener: (user: User | null) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Redirect-based GitHub OAuth. Opens the platform's hosted OAuth start URL,
   * which redirects back to the current page with a session token in the hash.
   */
  signIn(): void {
    const returnTo = window.location.href;
    const url = new URL('/v1/auth/github/start', this.apiBase);
    url.searchParams.set('app_id', this.appId);
    url.searchParams.set('return_to', returnTo);
    window.location.assign(url.toString());
  }

  signOut(): void {
    this.session = null;
    window.localStorage.removeItem(STORAGE_KEY);
    this.emit();
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
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash.startsWith('#fas_session=')) return;
    const token = decodeURIComponent(hash.slice('#fas_session='.length));
    const user = await this.fetchUser(token);
    this.session = { token, user };
    this.writeStorage(this.session);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    this.emit();
  }

  private async fetchUser(token: string): Promise<User> {
    const res = await fetch(new URL('/v1/auth/me', this.apiBase), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    return (await res.json()) as User;
  }

  private readStorage(): Session | null {
    if (typeof window === 'undefined') return null;
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

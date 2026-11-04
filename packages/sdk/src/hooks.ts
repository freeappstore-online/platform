import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Friend } from './friends.js';
import type { FreeAppStore } from './index.js';
import { createPreferenceStore } from './preferences.js';

export type { User } from './types.js';
export type { UseVoiceInputReturn } from './voice.js';
export { useVoiceInput } from './voice.js';

type ThemePreference = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? getSystemTheme() : pref;
}

function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  if (theme === 'dark') {
    document.documentElement.dataset.theme = 'dark';
  } else {
    delete document.documentElement.dataset.theme;
  }
}

const themeStore = createPreferenceStore({
  key: 'stores-theme',
  defaultValue: 'system' as ThemePreference,
  parse: (stored): ThemePreference => (stored === 'light' || stored === 'dark' ? stored : 'system'),
  resolve: (preference) => ({ preference, theme: resolveTheme(preference) }),
  apply: (snapshot) => applyTheme(snapshot.theme),
});

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    // Resolve from the active choice, including a choice that could not be persisted.
    themeStore.refresh();
  });
}

/**
 * Theme hook — zero-provider. Persists preference, applies data-theme on html element.
 *
 * Usage:
 * ```tsx
 * const { theme, preference, setPreference } = useTheme()
 * // theme: 'light' | 'dark' (resolved)
 * // preference: 'light' | 'dark' | 'system' (user's choice)
 * ```
 */
export function useTheme() {
  const snapshot = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
    themeStore.getSnapshot,
  );
  return { theme: snapshot.theme, preference: snapshot.preference, setPreference: themeStore.set };
}

/**
 * Auth state + actions. The primary way apps interact with platform identity.
 *
 * Usage:
 * ```tsx
 * const { user, loading, signIn, signOut, deleteAccount } = useAuth(fas)
 * if (loading) return <Spinner />
 * if (!user) return <button onClick={signIn}>Sign in</button>
 * return <p>Welcome, {user.login}!</p>
 * ```
 */
export function useAuth(app: FreeAppStore) {
  const [state, setState] = useState(() => ({ app, user: app.auth.user, loading: true }));
  // Do not expose the previous app's user for the render before effects run.
  const { user, loading } = state.app === app ? state : { user: app.auth.user, loading: true };

  useEffect(() => {
    let active = true;
    setState({ app, user: app.auth.user, loading: true });
    const unsubscribe = app.auth.onChange((user) => {
      if (active)
        setState((current) => ({ app, user, loading: current.app !== app || current.loading }));
    });
    const ready = () => {
      if (active) setState({ app, user: app.auth.user, loading: false });
    };
    void app.auth.init().then(ready, ready);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [app]);

  const signIn = useCallback(() => app.auth.signIn(), [app]);
  const signOut = useCallback(() => app.auth.signOut(), [app]);

  // Really deletes the account server-side (not just local KV), then signs out.
  const deleteAccount = useCallback(() => app.auth.deleteAccount(), [app]);

  const hasRole = useCallback((role: string) => app.roles.check(role), [app]);

  return { user, loading, signIn, signOut, deleteAccount, hasRole };
}

/**
 * Friends hook — fetches friends + incoming requests on mount.
 *
 * Usage:
 * ```tsx
 * const { friends, requests, loading, requestCount, refresh } = useFriends(fas)
 * ```
 */
export function useFriends(app: FreeAppStore) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [requests, setRequests] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([app.friends.list('accepted'), app.friends.requests()])
      .then(([f, r]) => {
        setFriends(f);
        setRequests(r);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [app]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { friends, requests, loading, requestCount: requests.length, refresh };
}

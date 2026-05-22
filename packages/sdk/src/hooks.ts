import { useSyncExternalStore, useState, useEffect, useCallback } from 'react';
import type { FreeAppStore } from './index.js';
import type { User } from './types.js';

export type { User } from './types.js';

const THEME_KEY = 'fas:theme';

type ThemePreference = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

// Shared theme state — all useTheme() callers share this via DOM + localStorage
const themeListeners = new Set<() => void>();

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? getSystemTheme() : pref;
}

function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  // Also toggle the 'dark' class used by the store sites' CSS
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

function notifyThemeListeners(): void {
  for (const fn of themeListeners) fn();
}

// Initialize on first import (browser only)
if (typeof window !== 'undefined') {
  applyTheme(resolveTheme(getStoredPreference()));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getStoredPreference() === 'system') {
      applyTheme(getSystemTheme());
      notifyThemeListeners();
    }
  });
}

function subscribeTheme(cb: () => void): () => void {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

function getThemeSnapshot(): { theme: ResolvedTheme; preference: ThemePreference } {
  const preference = getStoredPreference();
  return { theme: resolveTheme(preference), preference };
}

// Stable reference for useSyncExternalStore — only changes when listeners fire
let cachedSnapshot = getThemeSnapshot();

function getSnapshot(): { theme: ResolvedTheme; preference: ThemePreference } {
  return cachedSnapshot;
}

/**
 * Theme hook — zero-provider. Reads/writes localStorage, applies data-theme on <html>.
 *
 * Usage:
 * ```tsx
 * const { theme, preference, setPreference } = useTheme()
 * // theme: 'light' | 'dark' (resolved)
 * // preference: 'light' | 'dark' | 'system' (user's choice)
 * ```
 */
export function useTheme() {
  const snapshot = useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot);

  const setPreference = useCallback((pref: ThemePreference) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(THEME_KEY, pref);
    applyTheme(resolveTheme(pref));
    cachedSnapshot = getThemeSnapshot();
    notifyThemeListeners();
  }, []);

  return { theme: snapshot.theme, preference: snapshot.preference, setPreference };
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
  const [user, setUser] = useState<User | null>(app.auth.user);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    app.auth.init().finally(() => setLoading(false));
    return app.auth.onChange(setUser);
  }, [app]);

  const signIn = useCallback(() => app.auth.signIn(), [app]);
  const signOut = useCallback(() => app.auth.signOut(), [app]);

  const deleteAccount = useCallback(async () => {
    try {
      const keys = await app.kv.list();
      for (const key of keys) {
        await app.kv.delete(key).catch(() => {});
      }
    } catch {}
    app.auth.signOut();
  }, [app]);

  const hasRole = useCallback(
    (role: string) => app.roles.check(role),
    [app],
  );

  return { user, loading, signIn, signOut, deleteAccount, hasRole };
}

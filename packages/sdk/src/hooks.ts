import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Friend } from './friends.js';
import type { FreeAppStore } from './index.js';
import { createPreferenceStore } from './preferences.js';
import type { User } from './types.js';

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

export interface ConnectedDraftState<T> {
  user: User | null;
  value: T;
  draft: T;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  setDraft(value: T): void;
  save(): Promise<void>;
  retry(): void;
}

/**
 * Race-safe editor for a private per-account KV value. Delayed loads cannot
 * replace typing, and account changes/sign-out cancel work and isolate drafts.
 */
export function useConnectedKvDraft<T>(
  app: FreeAppStore,
  key: string,
  initialValue: T,
): ConnectedDraftState<T> {
  const { user } = useAuth(app);
  const userId = user?.id ?? null;
  const [retryKey, setRetryKey] = useState(0);
  const initialRef = useRef(initialValue);
  initialRef.current = initialValue;
  const scopeMatches = useCallback(
    (scope: { app: FreeAppStore; key: string; userId: string | null }) =>
      scope.app === app && scope.key === key && scope.userId === userId,
    [app, key, userId],
  );
  const [state, setState] = useState(() => ({
    scope: { app, key, userId },
    value: initialValue,
    draft: initialValue,
    loading: Boolean(userId),
    saving: false,
    dirty: false,
    error: null as string | null,
  }));
  const request = useRef({
    controller: null as AbortController | null,
    edits: 0,
    app,
    key,
    userId,
    retry: 0,
  });

  useEffect(() => {
    const controller = new AbortController();
    request.current.controller?.abort();
    const changedScope =
      request.current.app !== app ||
      request.current.key !== key ||
      request.current.userId !== userId;
    const retrying = retryKey > request.current.retry;
    request.current = {
      controller,
      edits: changedScope ? 0 : request.current.edits,
      app,
      key,
      userId,
      retry: retryKey,
    };
    let active = true;
    const scope = { app, key, userId };
    if (changedScope) {
      setState({
        scope,
        value: initialRef.current,
        draft: initialRef.current,
        loading: Boolean(userId),
        saving: false,
        dirty: false,
        error: null,
      });
    } else {
      setState((current) =>
        current.scope.app === app && current.scope.key === key && current.scope.userId === userId
          ? {
              ...current,
              loading: Boolean(userId),
              saving: retrying ? false : current.saving,
              error: retrying ? null : current.error,
            }
          : current,
      );
    }
    if (userId) {
      void app.kv
        .get<T>(key, { signal: controller.signal })
        .then((loaded) => {
          if (!active || controller.signal.aborted || app.auth.user?.id !== userId) return;
          const latest = request.current;
          if (latest.app !== app || latest.key !== key || latest.userId !== userId) return;
          if (latest.edits > 0) {
            setState((current) =>
              current.scope.app === app &&
              current.scope.key === key &&
              current.scope.userId === userId
                ? { ...current, loading: false }
                : current,
            );
            return;
          }
          const value = loaded === null ? initialRef.current : loaded;
          setState({
            scope,
            value,
            draft: value,
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          });
        })
        .catch((error: unknown) => {
          if (!active || controller.signal.aborted || app.auth.user?.id !== userId) return;
          setState((current) =>
            current.scope.app === app &&
            current.scope.key === key &&
            current.scope.userId === userId
              ? {
                  ...current,
                  loading: false,
                  error: error instanceof Error ? error.message : 'Could not load saved data.',
                }
              : current,
          );
        });
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [app, key, userId, retryKey]);

  const setDraft = useCallback(
    (draft: T) => {
      if (
        request.current.app === app &&
        request.current.key === key &&
        request.current.userId === userId
      ) {
        request.current.edits++;
      }
      setState((current) =>
        scopeMatches(current.scope) ? { ...current, draft, dirty: true, error: null } : current,
      );
    },
    [app, key, userId, scopeMatches],
  );
  const save = useCallback(async () => {
    if (!userId || app.auth.user?.id !== userId || !scopeMatches(state.scope)) return;
    const draft = state.draft;
    const controller = request.current.controller;
    setState((current) =>
      scopeMatches(current.scope) ? { ...current, saving: true, error: null } : current,
    );
    try {
      await app.kv.set(key, draft, { ...(controller && { signal: controller.signal }) });
      if (app.auth.user?.id !== userId || controller?.signal.aborted) return;
      setState((current) =>
        scopeMatches(current.scope)
          ? {
              ...current,
              value: draft,
              dirty: !Object.is(current.draft, draft),
              saving: false,
            }
          : current,
      );
    } catch (error) {
      if (app.auth.user?.id !== userId || controller?.signal.aborted) return;
      setState((current) =>
        scopeMatches(current.scope)
          ? {
              ...current,
              saving: false,
              error: error instanceof Error ? error.message : 'Could not save changes.',
            }
          : current,
      );
    }
  }, [app, key, scopeMatches, state.draft, state.scope, userId]);
  const retry = useCallback(() => setRetryKey((n) => n + 1), []);

  const visible = scopeMatches(state.scope)
    ? state
    : {
        scope: { app, key, userId },
        value: initialValue,
        draft: initialValue,
        loading: Boolean(userId),
        saving: false,
        dirty: false,
        error: null as string | null,
      };
  return {
    user,
    value: visible.value,
    draft: visible.draft,
    loading: visible.loading,
    saving: visible.saving,
    dirty: visible.dirty,
    error: visible.error,
    setDraft,
    save,
    retry,
  };
}

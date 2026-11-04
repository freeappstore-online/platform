/** Shared in-memory preferences; persistence is optional when storage is blocked. */
export function createPreferenceStore<Preference, Snapshot>(options: {
  key: string;
  defaultValue: Preference;
  parse: (stored: string | null) => Preference;
  resolve: (preference: Preference) => Snapshot;
  apply: (snapshot: Snapshot) => void;
}) {
  let preference = options.defaultValue;
  if (typeof window !== 'undefined') {
    try {
      preference = options.parse(window.localStorage.getItem(options.key));
    } catch {
      // Memory-only preferences still work in storage-restricted webviews.
    }
  }
  let snapshot = options.resolve(preference);
  const listeners = new Set<() => void>();
  const update = (next: Preference) => {
    preference = next;
    snapshot = options.resolve(next);
    options.apply(snapshot);
    for (const listener of listeners) listener();
  };

  if (typeof window !== 'undefined') {
    options.apply(snapshot);
    window.addEventListener('storage', (event) => {
      if (event.key !== null && event.key !== options.key) return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      update(options.parse(event.key === null ? null : event.newValue));
    });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: Preference) {
      if (typeof window === 'undefined') return;
      update(next);
      try {
        window.localStorage.setItem(options.key, String(next));
      } catch {
        // Keep the chosen value in memory instead of rereading stale storage.
      }
    },
    refresh() {
      update(preference);
    },
  };
}

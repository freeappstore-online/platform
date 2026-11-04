import {
  checkSegment,
  classifyStorageError,
  errorMessage,
  failure,
  type StorageResult,
  type Validator,
} from './status.js';

/**
 * Safe preference storage on `localStorage`.
 *
 * Keys are `fas:<namespace>:<key>`. Values are JSON. A validator rejects a
 * value without deleting the stored bytes. Cross-tab `watchPreference` events
 * are notifications that a key changed. They are not a merge and not conflict
 * resolution: the app reads the key and applies its own policy.
 *
 * Device-only. This is not `fas.kv` and not an account backup.
 */

export interface PreferenceNotice {
  namespace: string;
  key: string;
  kind: 'set' | 'remove';
  /** Always this literal. The notice carries no merged value. */
  notification: 'storage-changed';
}

export function preferenceKey(namespace: string, key: string): StorageResult<string> {
  const ns = checkSegment(namespace, 'Namespace');
  if (!ns.ok) return ns;
  const segment = checkSegment(key, 'Key');
  if (!segment.ok) return segment;
  return { ok: true, value: `fas:${ns.value}:${segment.value}` };
}

function storageArea(): Storage | null {
  try {
    if (typeof window === 'undefined' || window.localStorage == null) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function notify(namespace: string, key: string, kind: PreferenceNotice['kind']): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const notice: PreferenceNotice = { namespace, key, kind, notification: 'storage-changed' };
  try {
    const channel = new BroadcastChannel(`fas:prefs:${namespace}`);
    channel.postMessage(notice);
    channel.close();
  } catch {
    // The write already committed. A missing channel does not undo it.
  }
}

export function getPreference<T>(
  namespace: string,
  key: string,
  validate?: Validator<T>,
): StorageResult<T | undefined> {
  const storageKey = preferenceKey(namespace, key);
  if (!storageKey.ok) return storageKey;
  const area = storageArea();
  if (!area) return failure('unavailable', 'localStorage is not available.');
  let raw: string | null;
  try {
    raw = area.getItem(storageKey.value);
  } catch (error) {
    return failure(classifyStorageError(error), errorMessage(error));
  }
  if (raw === null) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Leave the unreadable bytes in place. Callers decide whether to overwrite.
    return failure('corrupt', 'Stored value is not valid JSON.');
  }
  if (validate) {
    if (!validate(parsed)) {
      return failure('validation', 'Stored value did not match the validator.');
    }
    return { ok: true, value: parsed };
  }
  return { ok: true, value: parsed as T };
}

export function setPreference<T>(
  namespace: string,
  key: string,
  value: T,
  validate?: Validator<T>,
): StorageResult<T> {
  const storageKey = preferenceKey(namespace, key);
  if (!storageKey.ok) return storageKey;
  if (validate && !validate(value)) {
    return failure('validation', 'Value did not match the validator.');
  }
  let encoded: string;
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return failure('validation', 'Value is not JSON.');
    encoded = json;
  } catch {
    return failure('validation', 'Value is not JSON.');
  }
  const area = storageArea();
  if (!area) return failure('unavailable', 'localStorage is not available.');
  try {
    area.setItem(storageKey.value, encoded);
  } catch (error) {
    return failure(classifyStorageError(error), errorMessage(error));
  }
  notify(namespace, key, 'set');
  return { ok: true, value };
}

export function removePreference(namespace: string, key: string): StorageResult<true> {
  const storageKey = preferenceKey(namespace, key);
  if (!storageKey.ok) return storageKey;
  const area = storageArea();
  if (!area) return failure('unavailable', 'localStorage is not available.');
  try {
    area.removeItem(storageKey.value);
  } catch (error) {
    return failure(classifyStorageError(error), errorMessage(error));
  }
  notify(namespace, key, 'remove');
  return { ok: true, value: true };
}

/**
 * Subscribe to preference changes.
 *
 * The `storage` event covers other tabs. `BroadcastChannel` covers other
 * listeners, including this tab, after a successful write. Neither path
 * merges values or picks a winner. Read the key again and apply an app-owned
 * policy if two tabs disagree.
 */
export function watchPreference(
  namespace: string,
  key: string,
  listener: (notice: PreferenceNotice) => void,
): () => void {
  const storageKey = preferenceKey(namespace, key);
  if (!storageKey.ok || typeof window === 'undefined') return () => undefined;

  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== storageKey.value) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    listener({
      namespace,
      key,
      kind: event.key !== null && event.newValue !== null ? 'set' : 'remove',
      notification: 'storage-changed',
    });
  };
  window.addEventListener('storage', onStorage);

  let channel: BroadcastChannel | undefined;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(`fas:prefs:${namespace}`);
      channel.onmessage = (event: MessageEvent<PreferenceNotice>) => {
        const notice = event.data;
        if (!notice || notice.namespace !== namespace || notice.key !== key) return;
        if (notice.notification !== 'storage-changed') return;
        listener({
          namespace,
          key,
          kind: notice.kind === 'remove' ? 'remove' : 'set',
          notification: 'storage-changed',
        });
      };
    }
  } catch {
    channel = undefined;
  }

  return () => {
    window.removeEventListener('storage', onStorage);
    channel?.close();
  };
}

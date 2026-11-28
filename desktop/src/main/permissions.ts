import type { Session, WebContents } from 'electron';

const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const labels: Record<string, string> = {
  geolocation: 'your location',
  notifications: 'notifications',
  'media:audio': 'your microphone',
  'media:video': 'your camera',
};
const ordinary = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'screen-wake-lock',
  'persistent-storage',
]);

/** All other permission classes are denied. Grants last only for the current app window. */
export function installPermissions(
  session: Session,
  host: {
    origin(contents: WebContents): string | null;
    ask(contents: WebContents, origin: string, access: string): Promise<boolean>;
  },
) {
  const grants = new WeakMap<WebContents, Set<string>>();
  const pending = new WeakSet<WebContents>();
  function trusted(contents: WebContents | null, url: string, main: boolean) {
    if (!contents || contents.isDestroyed() || !main) return null;
    const expected = host.origin(contents);
    return expected && origin(url) === expected && origin(contents.getURL()) === expected
      ? expected
      : null;
  }
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!trusted(contents, requestingOrigin, details.isMainFrame)) return false;
    if (ordinary.has(permission)) return true;
    const key = permission === 'media' ? `media:${details.mediaType}` : permission;
    return Boolean(grants.get(contents!)?.has(key));
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const expected = trusted(contents, details.requestingUrl, details.isMainFrame);
    if (!expected) return callback(false);
    if (ordinary.has(permission)) return callback(true);
    const keys =
      permission === 'media'
        ? ('mediaTypes' in details ? (details.mediaTypes ?? []) : []).map((type) => `media:${type}`)
        : [permission];
    if (!keys.length || keys.some((key) => !labels[key])) return callback(false);
    const allowed = grants.get(contents) ?? new Set<string>();
    if (keys.every((key) => allowed.has(key))) return callback(true);
    if (pending.has(contents)) return callback(false);
    pending.add(contents);
    void host
      .ask(contents, expected, keys.map((key) => labels[key]).join(' and '))
      .then(
        (approved) => {
          if (!approved || trusted(contents, details.requestingUrl, true) !== expected)
            return callback(false);
          for (const key of keys) allowed.add(key);
          grants.set(contents, allowed);
          callback(true);
        },
        () => callback(false),
      )
      .finally(() => pending.delete(contents));
  });
}

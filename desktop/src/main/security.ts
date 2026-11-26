import { createHash, timingSafeEqual } from 'node:crypto';

/** FAS app ids, as used in `<id>.freeappstore.online`. */
export const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The address every listener binds to: loopback only. */
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 47821;

/** The origin an app is served from. Dev builds can point every app at a local dev server. */
export function appOrigin(appId: string, devOrigin?: string): string {
  return devOrigin ?? `https://${appId}.freeappstore.online`;
}

/**
 * Who may open the bridge WebSocket, from its `Origin` header:
 * - `https://<id>.freeappstore.online` may register app `<id>` only;
 * - in dev builds, `http://localhost:*` and `http://127.0.0.1:*` may register any app id;
 * - everything else (including no Origin) is refused.
 * Returns the app id the origin must register (`'*'` for any), or null when refused.
 */
export function bridgeOriginAppId(origin: string | undefined, dev: boolean): string | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const app = /^([a-z0-9-]+)\.freeappstore\.online$/.exec(url.hostname)?.[1];
  if (url.protocol === 'https:' && !url.port && app && APP_ID.test(app)) return app;
  if (dev && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    return '*';
  }
  return null;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Checks an `Authorization: Bearer <token>` header in constant time. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const presented = /^Bearer (\S+)$/.exec(header ?? '')?.[1] ?? '';
  // Hashing first gives equal-length inputs, so timingSafeEqual never throws or leaks length.
  return timingSafeEqual(digest(presented), digest(token)) && presented.length > 0;
}

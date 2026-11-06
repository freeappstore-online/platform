/**
 * Service-to-service calls. The admin and agent Workers reach the backend
 * over a service binding as https://backend/…; no public hostname is ever
 * `backend`, so the hostname proves the call never crossed the internet.
 */
import type { Env } from '../types.js';
import { hasInternalToken } from './auth.js';

/**
 * Allow exactly the service-binding host, not "anything but the public
 * domain": that deny-list let any other hostname the Worker answers on
 * (workers.dev, preview URLs) reach internal routes (#427).
 */
export function isServiceBindingCall(url: string): boolean {
  return new URL(url).hostname === 'backend';
}

/**
 * Auth for /v1/internal/*: the request must arrive over the service binding
 * AND carry ADMIN_PROVISION_TOKEN. The token alone was accepted from the
 * public host, so a leaked token was usable from anywhere (#489).
 */
export function isInternalCall(c: {
  env: Env;
  req: { url: string; header: (name: string) => string | undefined };
}): boolean {
  return isServiceBindingCall(c.req.url) && hasInternalToken(c);
}

/**
 * The admin who triggered an internal call, as forwarded by the admin Worker
 * in `X-Acting-Admin` (#534). Trusted only on the service binding: a header
 * sent to any public host is ignored. Callers must already have passed
 * isInternalCall.
 */
export function actingAdmin(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): string | null {
  if (!isServiceBindingCall(c.req.url)) return null;
  const login = c.req.header('x-acting-admin')?.trim();
  return login && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,119}$/.test(login) ? login : null;
}

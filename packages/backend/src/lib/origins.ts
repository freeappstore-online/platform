/**
 * Returns true if `returnTo` points at an origin we'll redirect back to with
 * a session token. Anything else is rejected to prevent token-leak via
 * attacker-controlled `return_to` values.
 *
 * Allowed:
 *  - any HTTPS host on freeappstore.online (apex or subdomain)
 *  - localhost / 127.0.0.1 on http or https (dev only)
 */
export function isAllowedReturnTo(returnTo: string): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const isDevHost = host === 'localhost' || host === '127.0.0.1';
  if (isDevHost) {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  if (url.protocol !== 'https:') return false;
  return host === 'freeappstore.online' || host.endsWith('.freeappstore.online');
}

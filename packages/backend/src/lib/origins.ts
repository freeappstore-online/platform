/**
 * Allowed:
 *  - any HTTPS host on freeappstore.online (apex or subdomain)
 *  - localhost / 127.0.0.1 on http or https (dev only)
 *
 * Used for both:
 *  - the `return_to` allowlist on /v1/auth/github/start, to prevent
 *    token-leak via attacker-controlled redirect targets
 *  - the CORS origin allowlist for cross-origin fetches into the API
 */
function isAllowedHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }
  if (url.protocol !== 'https:') return false;
  return host === 'freeappstore.online' || host.endsWith('.freeappstore.online');
}

export function isAllowedReturnTo(returnTo: string): boolean {
  try {
    return isAllowedHost(new URL(returnTo));
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string): boolean {
  try {
    return isAllowedHost(new URL(origin));
  } catch {
    return false;
  }
}

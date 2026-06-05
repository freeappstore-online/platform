/**
 * Allowed:
 *  - any HTTPS host on freeappstore.online (apex or subdomain)
 *  - any HTTPS host on proappstore.online (apex or subdomain)
 *  - any HTTPS host on freegamestore.online (apex or subdomain)
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
  if (host === 'freeappstore.online' || host.endsWith('.freeappstore.online')) return true;
  if (host === 'proappstore.online' || host.endsWith('.proappstore.online')) return true;
  // FGS games run on freegamestore.online subdomains and share the FAS
  // backend (analytics, auth, KV). Without this, beacon fetch-fallbacks
  // and `window.fasAnalytics.event()` calls from game code hit CORS errors.
  if (host === 'freegamestore.online' || host.endsWith('.freegamestore.online')) return true;
  // Agent stores share the FAS auth backend
  if (host === 'freeagentstore.online' || host.endsWith('.freeagentstore.online')) return true;
  if (host === 'proagentstore.online' || host.endsWith('.proagentstore.online')) return true;
  // Custom domains for FAS apps
  if (host === 'agentcoder.space' || host.endsWith('.agentcoder.space')) return true;
  return false;
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

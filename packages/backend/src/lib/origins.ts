/**
 * Two allowlists:
 *
 *  - `isAllowedReturnTo(returnTo, appId)` — where /v1/auth/*\/start may send a
 *    session. Bound to the app id (#495): a session is scoped to the app it
 *    was delivered to, so the delivery target must be that app's own origin.
 *      - a first-party id (`console`, `store`, `fas-admin`, `keys`) → its own
 *        origin on freeappstore.online;
 *      - `mcp` / `ofo-copilot-extension` → their server-side / extension
 *        callbacks;
 *      - any other id → `https://<appId>.<zone>` for a platform zone, an entry
 *        in APP_ORIGIN_EXCEPTIONS (aliases, custom domains), or localhost.
 *
 *  - `isAllowedOrigin(origin)` — the CORS allowlist: any https host on a
 *    platform zone plus localhost.
 */

/** Zones whose `<appId>.<zone>` hosts are app origins that share this backend. */
const APP_ZONES = [
  'freeappstore.online',
  'proappstore.online',
  // FGS games run on freegamestore.online subdomains and share the FAS
  // backend (analytics, auth, KV).
  'freegamestore.online',
  // Agent and idea stores share the FAS auth backend.
  'freeagentstore.online',
  'proagentstore.online',
  'freeideastore.online',
  'proideastore.online',
  // Custom domains for FAS apps
  'agentcoder.space',
];

/**
 * App ids whose sign-in may return somewhere other than `<appId>.<zone>`:
 * address aliases (a second `routes` row for the same app) and custom domains.
 * Keep in step with the host Worker's `routes` table.
 */
const APP_ORIGIN_EXCEPTIONS: Record<string, string[]> = {
  // host migration 0003: short addresses for two existing apps.
  'hanzi-practice': ['hanzi.freeappstore.online'],
  'hanzi-associations': ['yi.freeappstore.online'],
  // The FreeAgentStore creator console signs in through this backend
  // (fags/platform/console/web/src/App.tsx) and lives at /console/ on the apex.
  'fags-console': ['freeagentstore.online'],
};

/**
 * First-party ids → the one origin their session may be delivered to. A
 * session delivered there is minted with `aud: console` (sessionAudience);
 * the same id sent anywhere else (e.g. `mcp` to the FreeIdeaStore MCP worker)
 * gets an app-scoped session.
 */
const FIRST_PARTY_ORIGINS: Record<string, string[]> = {
  // The console is served at freeappstore.online/app/ and at its own host.
  console: ['https://freeappstore.online', 'https://console.freeappstore.online'],
  store: ['https://freeappstore.online'],
  'fas-admin': ['https://admin.freeappstore.online'],
  keys: ['https://api.freeappstore.online'],
  mcp: ['https://mcp.freeappstore.online'],
};

function isFirstPartyReturn(url: URL, appId: string): boolean {
  return (FIRST_PARTY_ORIGINS[appId] ?? []).includes(url.origin);
}

/**
 * The `aud` to mint for a session started with `appId` and delivered to
 * `returnTo` (already validated by isAllowedReturnTo): `console` for a
 * first-party id on its own origin (or localhost in dev), else the app id.
 */
export function sessionAudience(appId: string, returnTo: string): string {
  if (!(appId in FIRST_PARTY_ORIGINS)) return appId;
  try {
    const url = new URL(returnTo);
    return isLocalhost(url) || isFirstPartyReturn(url, appId) ? 'console' : appId;
  } catch {
    return appId;
  }
}

function isLocalhost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1') return false;
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isPlatformHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return false;
  return APP_ZONES.some((zone) => host === zone || host.endsWith(`.${zone}`));
}

function isAppOrigin(url: URL, appId: string): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (APP_ZONES.some((zone) => host === `${appId}.${zone}`)) return true;
  return (APP_ORIGIN_EXCEPTIONS[appId] ?? []).includes(host);
}

function isAllowedExtensionReturn(url: URL, appId: string): boolean {
  if (appId !== 'ofo-copilot-extension') return false;
  if (url.protocol !== 'https:') return false;
  if (!/^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname.toLowerCase())) return false;
  return url.pathname === '/ofo-copilot';
}

function isAllowedMcpWorkerReturn(url: URL, appId: string): boolean {
  if (appId !== 'mcp') return false;
  if (url.protocol !== 'https:') return false;
  return url.hostname.toLowerCase() === 'freeideastore-mcp.serge-the-dev.workers.dev';
}

export function isAllowedReturnTo(returnTo: string, appId: string): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  if (!appId) return false;
  if (isLocalhost(url)) return true;
  if (isFirstPartyReturn(url, appId)) return true;
  return (
    isAppOrigin(url, appId) ||
    isAllowedExtensionReturn(url, appId) ||
    isAllowedMcpWorkerReturn(url, appId)
  );
}

export function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLocalhost(url) || isPlatformHost(url);
  } catch {
    return false;
  }
}

/**
 * Two allowlists:
 *
 *  - `isAllowedReturnTo(returnTo, appId)` — where /v1/auth/*\/start may send a
 *    session. Bound to the app id (#495): a session is scoped to the app it
 *    was delivered to, so the delivery target must be that app's own origin.
 *      - a first-party id (`console`, `store`, `fas-admin`, `keys`, `mcp`) →
 *        only its own origin(s); never localhost, never an app subdomain;
 *      - `ofo-copilot-extension` → its Chrome identity redirect;
 *      - any other id must be a valid, unreserved app id, delivered to
 *        `https://<appId>.<zone>`, an entry in APP_ORIGIN_EXCEPTIONS (address
 *        aliases, custom domains), or localhost (dev).
 *    No userinfo, no non-default port (except on localhost).
 *
 *  - `isAllowedOrigin(origin)` — the CORS allowlist: any https host on an
 *    app zone, an APP_ORIGIN_EXCEPTIONS host, plus localhost.
 */
import { APP_ID_RE, isReservedAppId } from './apps.js';

/**
 * Zones whose `<appId>.<zone>` hosts are FAS app origins: freeappstore.online
 * and the custom domain of one FAS app. Other stores' zones are deliberately
 * absent (#536): each store has its own backend, so a FAS session is never
 * delivered to, and the FAS API never answers CORS for, an origin FAS does not
 * operate. With a single app zone per id, an app id also names one origin, so
 * the bare-id session audience cannot collide across stores (#511).
 */
const APP_ZONES = ['freeappstore.online', 'agentcoder.space'];

/**
 * App ids whose sign-in may return somewhere other than `<appId>.<zone>`:
 * address aliases and custom domains. The aliases are every prod `routes` row
 * whose hostname is not its app (`SELECT slug, zone, r2_prefix FROM routes
 * WHERE substr(r2_prefix, instr(r2_prefix, '/') + 1) <> slug`, 2026-11-06).
 */
const APP_ORIGIN_EXCEPTIONS: Record<string, string[]> = {
  // host migration 0003: short addresses for two existing apps.
  'hanzi-practice': ['hanzi.freeappstore.online'],
  'hanzi-associations': ['yi.freeappstore.online'],
  // Custom domain.
  agentcoder: ['agentcoder.space', 'www.agentcoder.space'],
  // Deliberate exception (#557, Serge 2026-11-08): the FreeAgentStore creator
  // console (https://freeagentstore.online/console/, source
  // fags/platform/console/web/src/App.tsx) is live and signs in through this
  // backend; FreeAgentStore has no auth backend of its own. Only the exact apex
  // host is allowed, never its subdomains. It is also CORS-allowed
  // (isAllowedOrigin), otherwise the session it receives is unusable. Remove it
  // if that console moves to its own backend.
  'fags-console': ['freeagentstore.online'],
};

/**
 * First-party ids → where their session may be delivered. A session delivered
 * there is minted with `aud: console` (sessionAudience). Each is reserved in
 * lib/apps.ts so no app can take the name.
 */
const FIRST_PARTY_RETURNS: Record<string, (url: URL) => boolean> = {
  // The console is served at freeappstore.online/app/ and at its own host.
  console: (u) =>
    (u.origin === 'https://freeappstore.online' &&
      (u.pathname === '/app' || u.pathname.startsWith('/app/'))) ||
    u.origin === 'https://console.freeappstore.online',
  // Any storefront page except the ones that redirect to docs.freeappstore.online
  // (sites/storefront/_redirects), which would carry the URL fragment there.
  store: (u) =>
    u.origin === 'https://freeappstore.online' &&
    !/^\/(docs|guidelines)(\.html|\/|$)/.test(u.pathname),
  'fas-admin': (u) => u.origin === 'https://admin.freeappstore.online',
  // The key-management page and nothing else on the API origin.
  keys: (u) => u.origin === 'https://api.freeappstore.online' && u.pathname === '/v1/keys',
  // The OAuth callback and nothing else (workers/mcp/src/auth-handler.ts).
  mcp: (u) => u.origin === 'https://mcp.freeappstore.online' && u.pathname === '/callback',
};

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

function isExceptionHost(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return Object.values(APP_ORIGIN_EXCEPTIONS).some((hosts) => hosts.includes(host));
}

function isAppOrigin(url: URL, appId: string): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (APP_ZONES.some((zone) => host === `${appId}.${zone}`)) return true;
  return (APP_ORIGIN_EXCEPTIONS[appId] ?? []).includes(host);
}

function isAllowedExtensionReturn(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (!/^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname.toLowerCase())) return false;
  return url.pathname === '/ofo-copilot';
}

export function isAllowedReturnTo(returnTo: string, appId: string): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  if (!appId) return false;
  if (url.username || url.password) return false;
  const local = isLocalhost(url);
  if (url.port && !local) return false;

  const firstParty = FIRST_PARTY_RETURNS[appId];
  if (firstParty) return firstParty(url);
  if (appId === 'ofo-copilot-extension') return isAllowedExtensionReturn(url);
  if (!APP_ID_RE.test(appId) || isReservedAppId(appId)) return false;
  return local || isAppOrigin(url, appId);
}

/**
 * The `aud` to mint for a session started with `appId` and delivered to
 * `returnTo`, both already accepted by isAllowedReturnTo: `console` for a
 * first-party id (which is only ever accepted on its own origin), else the
 * app id — which isAllowedReturnTo guarantees is an unreserved app id, so it
 * can never read as `console` or the legacy marker.
 */
export function sessionAudience(appId: string): string {
  return appId in FIRST_PARTY_RETURNS ? 'console' : appId;
}

export function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLocalhost(url) || isPlatformHost(url) || isExceptionHost(url);
  } catch {
    return false;
  }
}

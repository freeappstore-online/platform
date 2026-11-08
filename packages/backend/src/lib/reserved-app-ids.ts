/**
 * The one list of app ids no creator may publish (#515). The backend
 * (lib/apps.ts), the admin Worker's publish (workers/admin/src/publish.ts) and
 * the VibeCode agent's deploy (workers/agent/src/infra-exec.ts) all import it
 * by path, so it has no imports of its own. Before adding a name, check it is
 * not a live app id (sites/storefront/registry.json): reserving it would make
 * that app unpublishable.
 */
export const RESERVED_APP_IDS: ReadonlySet<string> = new Set([
  // Repos the platform itself lives in (#9): the repo already exists, and
  // publishing grants the creator push access to the app's repo.
  'platform',
  'admin',
  'agent',
  'mcp',
  'host',
  'console',
  'create',
  'publisher',
  'freeappstore',
  'freegamestore',
  'sdk',
  // First-party `app_id`s at /v1/auth/*/start (#495): a session minted for
  // one of these gets `aud: console`, so no creator may own the name.
  'store',
  'fas-admin',
  'cli',
  'keys',
  // The audience marker for pre-#495 tokens is not an app id either way, but
  // keep the word out of reach (#495).
  'legacy',
  // Existing app address aliases; provisioning these would replace their routes.
  'hanzi',
  'yi',
  // Platform hosts, and names that would pass for first-party sign-in,
  // account or support pages on <id>.freeappstore.online (#515).
  'api',
  'www',
  'mail',
  'publish',
  'status',
  'auth',
  'login',
  'signin',
  'sso',
  'oauth',
  'verify',
  'account',
  'security',
  'support',
  'billing',
  'github',
  // Former app_proxy_usage keys for the platform-wide caps (#567); those now
  // live under `platform:`-prefixed keys, which no app id can equal.
  'email-platform',
  'audit-run',
]);

export function isReservedAppId(id: string): boolean {
  const lower = id.toLowerCase();
  return RESERVED_APP_IDS.has(lower) || lower.startsWith('template-');
}

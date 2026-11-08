/**
 * Proxy allowlist: per-app rules for what upstream URLs the proxy will forward
 * to. The proxy refuses every host that has no rule for the app (#466), so a
 * rule is the only way an app reaches an upstream. Two responsibilities:
 *
 *   1. Validate rules at *registration* time. AI-provider hosts cannot carry an
 *      app secret (a leaked OpenAI key in this table could quietly drain a
 *      developer's account); they are allowed only as a `user_key` rule, which
 *      spends the signed-in user's own vault key.
 *   2. Match an inbound proxy request (URL + method) against the registered
 *      rules at *call* time, and return the rule that wins (or null).
 */
export interface AllowlistRule {
  pattern: string; // URL prefix, no globs
  /**
   * 'user_key' injects the signed-in user's own vault key for a provider host
   * (HOST_TO_PROVIDER); it has no secret. The others inject an app secret.
   */
  injectKind: 'query' | 'header' | 'bearer' | 'oauth2_cc' | 'user_key';
  injectName: string; // ignored for 'bearer', 'oauth2_cc' and 'user_key'
  secretName: string; // FK to app_secrets.name (client_id for oauth2_cc); '' for user_key
  secretName2: string; // FK to app_secrets.name for client_secret (oauth2_cc only)
  tokenUrl: string; // token endpoint URL (oauth2_cc only)
  methods: string[]; // upper-case HTTP verbs
}

/**
 * Hosts that must use the PAS key vault, not this proxy. Match is on the
 * registerable host (eTLD+1 conceptually); we check both exact and suffix
 * (`.openai.com`) so subdomains like `api.openai.com` are caught too.
 */
const AI_PROVIDER_HOSTS = [
  'openai.com',
  'anthropic.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
] as const;

/** Hosts whose calls spend the user's own vault key → the key vault provider id. */
export const HOST_TO_PROVIDER: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'openrouter.ai': 'openrouter',
  'api.openrouter.ai': 'openrouter',
  'generativelanguage.googleapis.com': 'google-ai',
  'api.replicate.com': 'replicate',
  'api.stability.ai': 'stability',
  'api.elevenlabs.io': 'elevenlabs',
  // api.stripe.com was removed in #495: a user's Stripe *secret* key relayed
  // by any browser app is unbounded, and payments are a compliance violation
  // on FAS anyway. A developer's own Stripe key still works via an app rule.
};

export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistError';
  }
}

/**
 * Validate a rule about to be inserted. Throws AllowlistError on rejection.
 * Caller is responsible for the auth + ownership checks.
 */
export function validateRule(input: {
  pattern: string;
  injectKind: string;
  injectName: string;
  secretName: string;
  secretName2?: string;
  tokenUrl?: string;
  methods: string[];
}): AllowlistRule {
  const { pattern, injectKind, injectName, secretName, methods } = input;

  if (!pattern.startsWith('https://')) {
    throw new AllowlistError('pattern must start with https://');
  }
  let url: URL;
  try {
    url = new URL(pattern);
  } catch {
    throw new AllowlistError('pattern is not a valid URL');
  }
  const validKinds = ['query', 'header', 'bearer', 'oauth2_cc', 'user_key'] as const;
  if (!validKinds.includes(injectKind as (typeof validKinds)[number])) {
    throw new AllowlistError(`injectKind must be one of: ${validKinds.join(', ')}`);
  }
  if (injectKind === 'user_key') {
    // The user's vault key may only ever be sent to its own provider host, and
    // the prefix must end the host (`https://api.openai.com.evil.com/` must not match).
    const host = url.hostname.toLowerCase();
    if (!HOST_TO_PROVIDER[host] || !pattern.toLowerCase().startsWith(`https://${host}/`)) {
      throw new AllowlistError(
        `user_key is only for key-vault provider hosts (${Object.keys(HOST_TO_PROVIDER).join(', ')}); the pattern must be https://<host>/...`,
      );
    }
    return {
      pattern,
      injectKind,
      injectName: '',
      secretName: '',
      secretName2: '',
      tokenUrl: '',
      methods: validateMethods(methods),
    };
  }
  if (isAiProviderHost(url.hostname)) {
    throw new AllowlistError(
      `host ${url.hostname} is reserved for the user key vault: allow it with injectKind 'user_key' (fas proxy allow --user-key); app secrets cannot be used with it`,
    );
  }
  if (injectKind !== 'bearer' && injectKind !== 'oauth2_cc' && !injectName) {
    throw new AllowlistError(`injectName is required for injectKind='${injectKind}'`);
  }
  if (!secretName) {
    throw new AllowlistError('secretName is required');
  }

  // OAuth2 client_credentials requires a second secret (client_secret) and a token URL
  const secretName2 = input.secretName2 ?? '';
  const tokenUrl = input.tokenUrl ?? '';
  if (injectKind === 'oauth2_cc') {
    if (!secretName2) {
      throw new AllowlistError('secretName2 (client_secret) is required for oauth2_cc');
    }
    if (!tokenUrl) {
      throw new AllowlistError('tokenUrl is required for oauth2_cc');
    }
    if (!tokenUrl.startsWith('https://')) {
      throw new AllowlistError('tokenUrl must start with https://');
    }
    let tokenHost: string;
    try {
      tokenHost = new URL(tokenUrl).hostname;
    } catch {
      throw new AllowlistError('tokenUrl is not a valid URL');
    }
    if (isAiProviderHost(tokenHost)) {
      throw new AllowlistError(`tokenUrl host ${tokenHost} is reserved for the PAS AI key vault`);
    }
    // Block private/internal hosts on tokenUrl (same as webhook validation)
    const h = tokenHost.toLowerCase();
    if (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h === '[::1]' ||
      h.endsWith('.local') ||
      h.startsWith('10.') ||
      h.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h === '169.254.169.254'
    ) {
      throw new AllowlistError('tokenUrl must not point to private/internal addresses');
    }
  }

  const upperMethods = validateMethods(methods);
  return {
    pattern,
    injectKind: injectKind as AllowlistRule['injectKind'],
    injectName,
    secretName,
    secretName2,
    tokenUrl,
    methods: upperMethods,
  };
}

function validateMethods(methods: string[]): string[] {
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new AllowlistError('methods must be a non-empty array');
  }
  const upperMethods = methods.map((m) => m.toUpperCase());
  for (const m of upperMethods) {
    if (!/^[A-Z]+$/.test(m)) {
      throw new AllowlistError(`invalid HTTP method: ${m}`);
    }
  }
  return upperMethods;
}

/**
 * The host of a stored pattern, or null when it doesn't parse.
 */
function ruleHost(pattern: string): string | null {
  try {
    return new URL(pattern).host;
  } catch {
    return null;
  }
}

/**
 * Pick the rule that matches an inbound proxy request. Returns null if none.
 * Match = pattern is a prefix of url, on the pattern's own host, AND method is allowed. If multiple rules
 * match, the longest pattern wins (most specific).
 */
export function pickRule(
  rules: AllowlistRule[],
  url: string,
  method: string,
): AllowlistRule | null {
  const upperMethod = method.toUpperCase();
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  let best: AllowlistRule | null = null;
  for (const rule of rules) {
    if (!url.startsWith(rule.pattern)) continue;
    // A pattern with no path (`https://api.x.com`) is also a prefix of
    // `https://api.x.com.evil.test/`: the host must be the rule's own (#562).
    if (ruleHost(rule.pattern) !== host) continue;
    if (!rule.methods.includes(upperMethod)) continue;
    if (best === null || rule.pattern.length > best.pattern.length) {
      best = rule;
    }
  }
  return best;
}

/**
 * Inject the (already decrypted) secret into a request per the rule.
 * Returns the new URL + headers to use for the upstream fetch.
 */
export function injectSecret(
  rule: AllowlistRule,
  url: string,
  headers: Headers,
  secret: string,
): { url: string; headers: Headers } {
  const out = new Headers(headers);
  if (rule.injectKind === 'header') {
    out.set(rule.injectName, secret);
    return { url, headers: out };
  }
  if (rule.injectKind === 'bearer' || rule.injectKind === 'oauth2_cc') {
    out.set('Authorization', `Bearer ${secret}`);
    return { url, headers: out };
  }
  // query
  const u = new URL(url);
  u.searchParams.set(rule.injectName, secret);
  return { url: u.toString(), headers: out };
}

export function isAiProviderHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  for (const blocked of AI_PROVIDER_HOSTS) {
    if (h === blocked || h.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

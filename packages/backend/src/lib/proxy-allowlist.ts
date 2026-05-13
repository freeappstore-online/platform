/**
 * Proxy allowlist: per-app rules for what upstream URLs the secret-injecting
 * proxy will forward to. Two responsibilities:
 *
 *   1. Hard blocklist of AI-provider hosts at *registration* time. Free-tier
 *      app proxy is for cheap third-party APIs (weather, music, etc.) — not
 *      for OpenAI/Anthropic/etc., which route through the PAS key vault and
 *      have real billing teeth. Block early so a leaked OpenAI key in this
 *      table can't quietly drain a developer's account.
 *   2. Match an inbound proxy request (URL + method) against the registered
 *      rules at *call* time, and return the rule that wins (or null).
 */
export interface AllowlistRule {
  pattern: string;          // URL prefix, no globs
  injectKind: 'query' | 'header' | 'bearer';
  injectName: string;       // ignored for 'bearer'
  secretName: string;       // FK to app_secrets.name
  methods: string[];        // upper-case HTTP verbs
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
  if (isAiProviderHost(url.hostname)) {
    throw new AllowlistError(
      `host ${url.hostname} is reserved for the PAS AI key vault and cannot be used with the free app-secret proxy`,
    );
  }
  if (injectKind !== 'query' && injectKind !== 'header' && injectKind !== 'bearer') {
    throw new AllowlistError(`injectKind must be 'query' | 'header' | 'bearer'`);
  }
  if (injectKind !== 'bearer' && !injectName) {
    throw new AllowlistError(`injectName is required for injectKind='${injectKind}'`);
  }
  if (!secretName) {
    throw new AllowlistError('secretName is required');
  }
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new AllowlistError('methods must be a non-empty array');
  }
  const upperMethods = methods.map((m) => m.toUpperCase());
  for (const m of upperMethods) {
    if (!/^[A-Z]+$/.test(m)) {
      throw new AllowlistError(`invalid HTTP method: ${m}`);
    }
  }
  return {
    pattern,
    injectKind,
    injectName,
    secretName,
    methods: upperMethods,
  };
}

/**
 * Pick the rule that matches an inbound proxy request. Returns null if none.
 * Match = pattern is a prefix of url AND method is allowed. If multiple rules
 * match, the longest pattern wins (most specific).
 */
export function pickRule(
  rules: AllowlistRule[],
  url: string,
  method: string,
): AllowlistRule | null {
  const upperMethod = method.toUpperCase();
  let best: AllowlistRule | null = null;
  for (const rule of rules) {
    if (!url.startsWith(rule.pattern)) continue;
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
  if (rule.injectKind === 'bearer') {
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

/**
 * Cloudflare AI Gateway routing for the agent's provider adapters.
 *
 * Vendored from the PAS implementation (proappstore-online/platform#22 —
 * pas/platform/.../runtimes/ai-gateway.ts), extended with a third provider
 * (`google`). Per the cross-store vendor rule we copy rather than import.
 *
 * When AI_GATEWAY_ACCOUNT_ID + AI_GATEWAY_ID are set, provider calls go through
 * the gateway instead of straight to the provider's public API. The user's BYO
 * key passes through unchanged (Anthropic prompt-caching preserved); the gateway
 * only adds caching, rate-limiting, fallback, and per-request token/cost
 * observability. Fully opt-in: with the vars unset every call falls back to the
 * provider's direct API, so shipping this changes nothing until it's wired up.
 *
 * Set up (one-time, per account):
 *   1. Dashboard → AI → AI Gateway → create a gateway (e.g. `fas-agent`).
 *   2. workers/agent/wrangler.toml [vars]: AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID.
 *   3. (optional) authenticated gateway: set AI_GATEWAY_TOKEN (via Doppler).
 */

export type GatewayProvider = "anthropic" | "openai" | "google";

/** Direct provider base URLs (callers append the provider's path suffix). */
const DIRECT_BASE: Record<GatewayProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com",
};

/** AI Gateway path segment per provider — Google's slug differs from our name. */
const GATEWAY_SLUG: Record<GatewayProvider, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-ai-studio",
};

/** Subset of the Worker env this module reads. Structurally a subset of Env. */
export type GatewayEnv = {
  AI_GATEWAY_ACCOUNT_ID?: string | undefined;
  AI_GATEWAY_ID?: string | undefined;
  AI_GATEWAY_TOKEN?: string | undefined;
};

/** True when AI Gateway routing is active for this environment. */
export function gatewayEnabled(env: GatewayEnv): boolean {
  return Boolean(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_ID);
}

/**
 * Provider base URL. Callers append the provider's endpoint path, which is the
 * same for gateway and direct forms:
 *   anthropic → `${base}/v1/messages`
 *   openai    → `${base}/chat/completions`
 *   google    → `${base}/v1beta/models/{model}:streamGenerateContent`
 */
export function providerBaseUrl(env: GatewayEnv, provider: GatewayProvider): string {
  if (gatewayEnabled(env)) {
    return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${GATEWAY_SLUG[provider]}`;
  }
  return DIRECT_BASE[provider];
}

/**
 * Extra request headers for AI Gateway. An "authenticated gateway" rejects
 * requests without `cf-aig-authorization`; set AI_GATEWAY_TOKEN to supply it.
 * Returns {} when unset (unauthenticated gateway or direct provider call).
 */
export function gatewayHeaders(env: GatewayEnv): Record<string, string> {
  return env.AI_GATEWAY_TOKEN ? { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` } : {};
}

/** Resolved gateway routing for one provider, passed into an adapter. */
export type GatewayConfig = {
  baseUrl: string;
  headers: Record<string, string>;
};

/** Build the per-provider routing config from the Worker env. */
export function resolveGateway(env: GatewayEnv, provider: GatewayProvider): GatewayConfig {
  return { baseUrl: providerBaseUrl(env, provider), headers: gatewayHeaders(env) };
}

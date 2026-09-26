/** Worker entry — routes requests to the correct Durable Object session. */

import { getConfig } from "./config";
import { corsHeaders } from "./cors";
import { AI_SOURCES, type AiSource } from "./providers/types";

export { AgentSession } from "./session";

export interface Env {
  SESSION: DurableObjectNamespace;
  PLATFORM?: Fetcher;
  DB: D1Database;
  GITHUB_TOKEN: string;
  STORE: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** Cloudflare AI Gateway routing (opt-in). When ACCOUNT_ID + ID are set,
   *  provider LLM calls route through the gateway for caching + cost/token
   *  observability. ACCOUNT_ID + ID live in wrangler.toml [vars]; the optional
   *  TOKEN (authenticated gateway) is managed from the private SOPS secrets repo.
   *  See providers/ai-gateway.ts. */
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_TOKEN?: string;
  /** "true" → chat turns run as a Durable Object alarm-driven state machine
   *  (one step per alarm, persisted between steps). Anything else → the
   *  legacy single-invocation loop. See session.ts (#41). */
  ALARM_LOOP?: string;
}

/** Map VibeCode provider names to platform key vault provider IDs. */
function mapProviderToVault(provider: string): string | null {
  const map: Record<string, string> = {
    openrouter: "openrouter",
    anthropic: "anthropic",
    openai: "openai",
    google: "google-ai",
  };
  return map[provider] ?? null;
}

/**
 * Fill in body.aiConfig's key/provider/model from the platform when the browser
 * sent no key, and say what funded the turn. A lookup failure is "none", which
 * the session reports as "No API key found".
 */
async function resolveAiKey(
  body: { aiConfig?: { provider?: string; apiKey?: string; model?: string } },
  authHeader: string,
  env: Env,
): Promise<AiSource> {
  const aiConfig = body.aiConfig;
  if (!aiConfig) return "none";
  if (aiConfig.apiKey) return "browser_key";
  if (!authHeader || !env.PLATFORM || !aiConfig.provider) return "none";
  const provider = mapProviderToVault(aiConfig.provider) ?? aiConfig.provider;
  try {
    const res = await env.PLATFORM.fetch(`https://backend/v1/keys/resolve-agent/${provider}`, { headers: { Authorization: authHeader } });
    if (!res.ok) return "none";
    const resolved = (await res.json()) as { key: string | null; provider?: string; model?: string; source?: string };
    if (resolved.key) {
      aiConfig.apiKey = resolved.key;
      if (resolved.provider) aiConfig.provider = resolved.provider;
      if (resolved.model) aiConfig.model = resolved.model;
    }
    return AI_SOURCES.includes(resolved.source as AiSource) ? (resolved.source as AiSource) : "none";
  } catch {
    return "none";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = getConfig(env.STORE);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, config.domain) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/" || path === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: config.agentName,
        }),
        {
          headers: { "Content-Type": "application/json", ...corsHeaders(request, config.domain) },
        },
      );
    }

    // Routes: /session/:id/chat, /session/:id/live, /session/:id/status, /session/:id/files, /session/:id/reset
    const match = path.match(/^\/session\/([a-zA-Z0-9_-]{1,64})\/(chat|live|status|files|history|errors|import|reset|push-subscribe)$/);
    if (!match) {
      return new Response(JSON.stringify({ error: "not found", hint: "Use /session/:id/chat" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders(request, config.domain) },
      });
    }

    const [, sessionId, route] = match;
    const subpath = `/${route}`;
    const doId = env.SESSION.idFromName(sessionId);
    const stub = env.SESSION.get(doId);

    // For /chat: resolve the API key from the platform (user vault, then a
    // complimentary grant) when the browser didn't send one, and record what
    // funded the turn as body.aiSource (#16). aiSource is always set here, so
    // a client can't claim its own; the key itself never goes into it.
    let forwardBody: BodyInit | undefined = request.method === "POST" ? (request.body ?? undefined) : undefined;

    if (route === "chat" && request.method === "POST") {
      const bodyText = await request.text();
      forwardBody = bodyText;
      try {
        const body = JSON.parse(bodyText);
        if (body && typeof body === "object") {
          body.aiSource = await resolveAiKey(body, request.headers.get("Authorization") || "", env);
          forwardBody = JSON.stringify(body);
        }
      } catch {
        // Unparseable body — forward it as-is; the session rejects it.
      }
    }

    const doHeaders = new Headers(request.headers);
    doHeaders.set("X-Session-Id", sessionId);

    const doRequest = new Request(`https://do${subpath}`, {
      method: request.method,
      headers: doHeaders,
      body: forwardBody,
    });

    return stub.fetch(doRequest);
  },
};

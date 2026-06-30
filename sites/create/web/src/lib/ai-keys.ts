/**
 * AI API key management — keys stored on the platform vault (encrypted, server-side).
 * Local keys are a legacy fallback for offline/pre-vault users and will be migrated up.
 */

import { getSession, API_URL } from "./api";

export interface ProviderConfig {
  type: string;
  name: string;
  description: string;
  keyPlaceholder: string;
  keyPrefix: string;
  free: boolean;
  models: { id: string; name: string }[];
  docsUrl: string;
}

// NOTE: GitHub Models was removed from the UI — it advertised "free, no key
// needed" but there's no server-side token, so it silently failed. The agent
// worker still has the adapter; re-add an entry here once a real token exists.
export const PROVIDERS: ProviderConfig[] = [
  {
    type: "openrouter",
    name: "OpenRouter",
    description: "367+ models with one API key. Claude, GPT, Gemini, Llama, Grok, and more.",
    keyPlaceholder: "sk-or-v1-...",
    keyPrefix: "sk-or-",
    free: false,
    models: [
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
      { id: "anthropic/claude-opus-4", name: "Claude Opus 4" },
      { id: "openai/gpt-4.1", name: "GPT-4.1" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3" },
      { id: "x-ai/grok-3-mini", name: "Grok 3 Mini" },
    ],
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    type: "anthropic",
    name: "Anthropic",
    description: "Claude models directly. Lowest latency for Claude.",
    keyPlaceholder: "sk-ant-api03-...",
    keyPrefix: "sk-ant-",
    free: false,
    models: [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ],
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    type: "openai",
    name: "OpenAI",
    description: "GPT and o-series models directly.",
    keyPlaceholder: "sk-proj-...",
    keyPrefix: "sk-",
    free: false,
    models: [
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "o3", name: "o3" },
      { id: "o4-mini", name: "o4 Mini" },
    ],
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    type: "google",
    name: "Google AI",
    description: "Gemini models directly. 1M+ context window.",
    keyPlaceholder: "AIza...",
    keyPrefix: "AIza",
    free: false,
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
    docsUrl: "https://aistudio.google.com/apikey",
  },
];

/** provider type → selectable models, derived from PROVIDERS. Shared by the
 *  studio toolbar/settings and the Create page's model validation. */
export const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = Object.fromEntries(
  PROVIDERS.map((p) => [p.type, p.models.map((m) => ({ value: m.id, label: m.name }))]),
);

// ── Platform vault API ──

export interface VaultKeyStatus {
  provider: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * The agent wire protocol uses provider type "google", but the platform key
 * vault (key_providers D1 table) registers it as "google-ai". Translate at the
 * vault boundary so a Google key can actually be stored and read back.
 */
export function toVaultProvider(type: string): string {
  return type === "google" ? "google-ai" : type;
}

function authHeaders(): Record<string, string> {
  const s = getSession();
  return s?.token
    ? { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", Accept: "application/json" }
    : { "Content-Type": "application/json", Accept: "application/json" };
}

export async function fetchVaultStatus(): Promise<VaultKeyStatus[]> {
  const s = getSession();
  if (!s?.token) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${API_URL}/v1/keys/status`, {
      headers: authHeaders(),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json() as { keys: VaultKeyStatus[] };
    return data.keys;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function saveKeyToVault(provider: string, value: string, label?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/keys/${toVaultProvider(provider)}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ value, label }),
    });
    return await res.json() as { ok: boolean; error?: string };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function deleteKeyFromVault(provider: string): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${API_URL}/v1/keys/${toVaultProvider(provider)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    return await res.json() as { ok: boolean };
  } catch {
    return { ok: false };
  }
}

// ── Usage ──

export interface VaultUsage {
  used: number;
  limit: number;
  day: string;
}

export async function fetchVaultUsage(): Promise<VaultUsage | null> {
  const s = getSession();
  if (!s?.token) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${API_URL}/v1/keys/usage`, {
      headers: authHeaders(),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json() as VaultUsage;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Legacy localStorage fallback ──
// Used during migration: if user has local keys, we offer to migrate them up.

const STORAGE_KEY = "fas_ai_keys";

export function getSavedKeys(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}

export function saveKey(provider: string, key: string) {
  const keys = getSavedKeys();
  if (key) keys[provider] = key;
  else delete keys[provider];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function getKey(provider: string): string {
  return getSavedKeys()[provider] || "";
}

export function deleteAllLocalKeys() {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasLocalKeys(): boolean {
  return Object.keys(getSavedKeys()).length > 0;
}

export function getDefaultProvider(): string {
  const stored = localStorage.getItem("fas_provider");
  // Fall back if the stored provider is no longer offered (e.g. legacy
  // "github" after we removed it from the dropdown).
  if (stored && PROVIDERS.some((p) => p.type === stored)) return stored;
  return "openrouter";
}

export function getDefaultModel(): string {
  return localStorage.getItem("fas_model") || "anthropic/claude-sonnet-4";
}

/**
 * Per-app API keys (the developer side of the platform proxy).
 *
 * The end user never enters a key. The developer adds one key per third-party
 * API here; the platform encrypts it (app_secrets) and the proxy injects it
 * server-side. Ownership is recorded at publish, so these endpoints 404 until
 * the app is published.
 */
import { API_URL, getSession } from "./api";

const FAS_ORG = "freeappstore-online";

export interface AppSecret {
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A declared API from the app's fas.json manifest (written by register_api). */
export interface ManifestApi {
  host: string;
  secretName: string;
  injectKind: "query" | "header" | "bearer";
  injectName?: string;
  pattern?: string;
  methods?: string[];
  description?: string;
}

function authHeaders(): Record<string, string> {
  const s = getSession();
  return s?.token
    ? { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

/** List which secret names already have a value. `published:false` => app not in the store yet. */
export async function fetchAppSecrets(appId: string): Promise<{ secrets: AppSecret[]; published: boolean }> {
  const res = await fetch(`${API_URL}/v1/apps/${appId}/secrets`, { headers: authHeaders() });
  if (res.status === 404 || res.status === 403) return { secrets: [], published: false };
  if (!res.ok) throw new Error(`Couldn't load keys (HTTP ${res.status})`);
  const data = (await res.json()) as { secrets?: AppSecret[] };
  return { secrets: data.secrets ?? [], published: true };
}

/** Store (or replace) the developer's key value for a secret name. */
export async function putAppSecret(appId: string, name: string, value: string): Promise<void> {
  const res = await fetch(`${API_URL}/v1/apps/${appId}/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error((await res.text()) || `Couldn't save key (HTTP ${res.status})`);
}

/** Create/replace the proxy allowlist rule that maps a host to the secret. */
export async function putAllowlistRule(appId: string, api: ManifestApi): Promise<void> {
  const res = await fetch(`${API_URL}/v1/apps/${appId}/allowlist`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({
      // Backend matches url.startsWith(pattern): a https:// URL PREFIX, no globs.
      pattern: api.pattern?.startsWith("https://") ? api.pattern : `https://${api.host}/`,
      injectKind: api.injectKind,
      injectName: api.injectName || "",
      secretName: api.secretName,
      methods: api.methods?.length ? api.methods : ["GET"],
    }),
  });
  if (!res.ok) throw new Error((await res.text()) || `Couldn't register API (HTTP ${res.status})`);
}

interface AllowlistRule {
  pattern: string;
  injectKind: string;
  injectName?: string;
  secretName: string;
  methods?: string[];
}

/** Read the proxy allowlist rules already registered for the app (owner auth).
 *  Lets the page show manually-added APIs (which have no fas.json entry). */
export async function fetchAllowlist(appId: string): Promise<ManifestApi[]> {
  const res = await fetch(`${API_URL}/v1/apps/${appId}/allowlist`, { headers: authHeaders() });
  if (!res.ok) return [];
  const data = (await res.json()) as { rules?: AllowlistRule[] };
  return (data.rules ?? []).map((r) => {
    let host = r.pattern;
    try { host = new URL(r.pattern).host; } catch { /* keep raw */ }
    return {
      host,
      secretName: r.secretName,
      injectKind: (r.injectKind as ManifestApi["injectKind"]) ?? "query",
      injectName: r.injectName,
      pattern: r.pattern,
      methods: r.methods,
    };
  });
}

/** Read the app's declared APIs from fas.json in its published GitHub repo (public). */
export async function fetchManifestApis(appId: string): Promise<ManifestApi[]> {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${FAS_ORG}/${appId}/main/fas.json`);
    if (!res.ok) return [];
    const data = (await res.json()) as { apis?: ManifestApi[] };
    return Array.isArray(data?.apis) ? data.apis : [];
  } catch {
    return [];
  }
}

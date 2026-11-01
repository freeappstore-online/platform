import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Nav } from "../components/Nav";
import { useAuth } from "../hooks/useAuth";
import {
  fetchAllowlist,
  fetchAppSecrets,
  fetchManifestApis,
  putAllowlistRule,
  putAppSecret,
  type ManifestApi,
} from "../lib/appSecrets";

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function AppKeys() {
  const { id: appId } = useParams();
  const { user, loading: authLoading, signIn } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [published, setPublished] = useState(true);
  const [apis, setApis] = useState<ManifestApi[]>([]);
  const [setNames, setSetNames] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!appId || !user) return;
    setLoading(true);
    setError(null);
    try {
      const [manifest, registered, secretsRes] = await Promise.all([
        fetchManifestApis(appId),
        fetchAllowlist(appId),
        fetchAppSecrets(appId),
      ]);
      // Union of declared (fas.json) + already-registered (allowlist) APIs,
      // deduped by secretName so manual adds persist across reloads.
      const byName = new Map<string, ManifestApi>();
      for (const a of [...manifest, ...registered]) byName.set(a.secretName, { ...byName.get(a.secretName), ...a });
      setApis([...byName.values()]);
      setPublished(secretsRes.published);
      setSetNames(new Set(secretsRes.secrets.map((s) => s.name)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [appId, user]);

  useEffect(() => { load(); }, [load]);

  if (authLoading) {
    return (<><Nav /><div className="container py-16 text-center text-muted">Loading…</div></>);
  }
  if (!user) {
    return (
      <><Nav /><div className="container py-16 text-center">
        <p className="mb-4 text-muted">Sign in to manage this app's API keys.</p>
        <button onClick={signIn} className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-accent border-0 cursor-pointer">Sign in with GitHub</button>
      </div></>
    );
  }

  return (
    <>
      <Nav />
      <div className="container py-8 max-w-[640px]">
        <div className="flex items-center gap-2 mb-1">
          <button onClick={() => navigate(`/app/${appId}`)} aria-label="Back to app" className="w-[36px] h-[36px] inline-flex items-center justify-center bg-transparent border border-line rounded-control-sm text-ink cursor-pointer">&#8592;</button>
          <h1 className="font-display text-xl font-extrabold text-ink-strong">API Keys</h1>
        </div>
        <p className="text-sm mb-6 text-muted">
          Keys for <strong>{appId}</strong>. Added once here, encrypted, and injected server-side — your app's
          users never enter them. (They sign in with GitHub to use the API.)
        </p>

        {loading && <p className="text-sm py-8 text-center text-muted">Loading…</p>}

        {!loading && error && (
          <div className="p-4 rounded-xl border mb-4 border-danger bg-[color-mix(in_srgb,_var(--danger)_8%,_var(--panel))]">
            <p className="text-sm text-danger">{error}</p>
            <button onClick={load} className="mt-2 text-xs font-semibold text-accent bg-transparent border-0 cursor-pointer">Retry</button>
          </div>
        )}

        {!loading && !error && !published && (
          <div className="p-4 rounded-xl border border-line bg-panel">
            <p className="text-sm font-semibold mb-1">Publish this app first</p>
            <p className="text-xs mb-3 text-muted">
              API keys can be added once the app is published to the store. Open the app and hit Publish.
            </p>
            <Link to={`/app/${appId}`} className="text-xs font-semibold text-accent">Back to the app →</Link>
          </div>
        )}

        {!loading && !error && published && (
          <>
            {apis.length === 0 && (
              <p className="text-sm mb-4 text-muted">
                No APIs configured yet. Apps the agent builds declare these automatically; otherwise add one below.
              </p>
            )}
            {apis.map((api) => (
              <ApiKeyRow key={api.secretName} appId={appId!} api={api} isSet={setNames.has(api.secretName)} onSaved={() => setSetNames((p) => new Set(p).add(api.secretName))} />
            ))}
            <ManualAddForm
              appId={appId!}
              existing={new Set(apis.map((a) => a.secretName))}
              onAdded={(api) => {
                setApis((prev) => (prev.some((a) => a.secretName === api.secretName) ? prev : [...prev, api]));
                setSetNames((p) => new Set(p).add(api.secretName));
              }}
            />
          </>
        )}
      </div>
    </>
  );
}

function ManualAddForm({ appId, existing, onAdded }: { appId: string; existing: Set<string>; onAdded: (api: ManifestApi) => void }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const [secretName, setSecretName] = useState("");
  const [injectKind, setInjectKind] = useState<"query" | "header" | "bearer">("query");
  const [injectName, setInjectName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);


  async function add() {
    setErr(null);
    const cleanHost = host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!cleanHost) return setErr("Host is required (e.g. api.openweathermap.org).");
    if (!SECRET_NAME_RE.test(secretName.trim())) return setErr("Secret name must be UPPER_SNAKE_CASE (e.g. OPENWEATHER_KEY).");
    if (existing.has(secretName.trim())) return setErr("That secret name is already configured.");
    if (injectKind !== "bearer" && !injectName.trim()) return setErr(`Inject name is required for ${injectKind} (e.g. "appid").`);
    if (!value.trim()) return setErr("Paste the API key.");
    const api: ManifestApi = {
      host: cleanHost,
      secretName: secretName.trim(),
      injectKind,
      injectName: injectKind === "bearer" ? undefined : injectName.trim(),
      pattern: `https://${cleanHost}/`,
      methods: ["GET"],
    };
    setSaving(true);
    try {
      await putAppSecret(appId, api.secretName, value.trim());
      await putAllowlistRule(appId, api);
      onAdded(api);
      setOpen(false);
      setHost(""); setSecretName(""); setInjectName(""); setValue(""); setInjectKind("query");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-semibold mt-2 text-accent bg-transparent border-0 cursor-pointer">
        + Add an API manually
      </button>
    );
  }

  return (
    <div className="p-4 rounded-xl border mt-2 bg-panel border-line">
      <div className="flex items-center justify-between mb-2">
        <strong className="text-sm">Add an API</strong>
        <button onClick={() => setOpen(false)} className="bg-transparent border-0 text-muted cursor-pointer">✕</button>
      </div>
      <div className="flex flex-col gap-2">
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Host — api.openweathermap.org" className="p-2 rounded-lg border text-sm bg-paper border-line text-ink" />
        <input value={secretName} onChange={(e) => setSecretName(e.target.value.toUpperCase())} placeholder="Secret name — OPENWEATHER_KEY" className="p-2 rounded-lg border text-sm bg-paper border-line text-ink font-[monospace]" />
        <div className="flex gap-2">
          <select value={injectKind} onChange={(e) => setInjectKind(e.target.value as typeof injectKind)} className="p-2 rounded-lg border text-sm bg-paper border-line text-ink">
            <option value="query">Query param</option>
            <option value="header">Header</option>
            <option value="bearer">Bearer token</option>
          </select>
          {injectKind !== "bearer" && (
            <input value={injectName} onChange={(e) => setInjectName(e.target.value)} placeholder={injectKind === "query" ? "param name — appid" : "header name — X-API-Key"} className="flex-1 p-2 rounded-lg border text-sm bg-paper border-line text-ink" />
          )}
        </div>
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="API key value" className="p-2 rounded-lg border text-sm bg-paper border-line text-ink font-[monospace]" onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        {err && <p className="text-xs text-danger">{err}</p>}
        <button onClick={add} disabled={saving} className={`p-2 rounded-lg text-sm font-semibold text-white bg-accent border-0 cursor-pointer ${(saving ? "opacity-[0.6]" : "opacity-[1]")}`} >
          {saving ? "Saving…" : "Add API + key"}
        </button>
      </div>
    </div>
  );
}

function ApiKeyRow({ appId, api, isSet, onSaved }: { appId: string; api: ManifestApi; isSet: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(isSet);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      // Store the key, then register the allowlist rule so the proxy knows
      // which host maps to it. Both are owner-authenticated.
      await putAppSecret(appId, api.secretName, value.trim());
      await putAllowlistRule(appId, api);
      setDone(true);
      setValue("");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 rounded-xl border mb-3 bg-panel border-line">
      <div className="flex items-center gap-2 mb-1">
        <strong className="text-sm">{api.host}</strong>
        {done && <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold bg-[color-mix(in_srgb,_var(--success)_15%,_var(--panel))] text-success">Key set</span>}
      </div>
      {api.description && <p className="text-xs mb-2 text-muted">{api.description}</p>}
      <p className="text-xs mb-2 text-muted">
        Secret <code>{api.secretName}</code> · sent as {api.injectKind}{api.injectName ? ` "${api.injectName}"` : ""}
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={done ? "Replace key…" : "Paste API key…"}
          className="flex-1 p-2 rounded-lg border text-sm bg-paper border-line text-ink font-[monospace]"
          onKeyDown={(e) => { if (e.key === "Enter") save(); }}
        />
        <button onClick={save} disabled={saving || !value.trim()} className={`px-3 rounded-lg text-sm font-semibold text-white bg-accent border-0 cursor-pointer ${(saving || !value.trim() ? "opacity-[0.5]" : "opacity-[1]")}`} >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {err && <p className="text-xs mt-1 text-danger">{err}</p>}
    </div>
  );
}

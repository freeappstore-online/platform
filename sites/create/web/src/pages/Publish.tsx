import { useState, useEffect, useCallback } from "react";
import { Nav } from "../components/Nav";
import { useAuth } from "../hooks/useAuth";
import { API_URL, getSession } from "../lib/api";

// Categories accepted by the backend's /v1/publish validator. Keep in sync with
// packages/backend/src/routes/publish.ts VALID_CATEGORIES.
const CATEGORIES = [
  "Learning", "Strategy", "Discovery", "Brain Training", "Social",
  "Productivity", "Health & Fitness", "Finance", "News & Weather",
  "Utilities", "Other (specify in description)",
] as const;

interface MyApp {
  id: string;
  store: string;
  category: string;
  type: string;
  oneliner: string;
  createdAt: number;
  appUrl: string;
  repoUrl: string;
}

interface AdminStep {
  name: string;
  status: string;
  detail?: string;
}

interface PublishResult {
  appId: string;
  appUrl: string;
  repoUrl: string;
  admin?: { steps?: AdminStep[] };
}

// Mirror the backend's APP_ID_RE: /^[a-z][a-z0-9-]{1,30}$/ (2–31 chars, starts
// with a letter). Client-side check just gives a friendlier error than a 400.
function validateId(id: string): string | null {
  if (!id) return null;
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id))
    return "2–31 chars: lowercase letters, digits, hyphens; must start with a letter.";
  if (id.startsWith("free") || id.startsWith("pro")) return "Cannot start with 'free' or 'pro'";
  return null;
}

function authHeaders(): Record<string, string> {
  const token = getSession()?.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function Publish() {
  const { user, loading, signIn } = useAuth();
  const [apps, setApps] = useState<MyApp[]>([]);
  const [loadingApps, setLoadingApps] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [idValue, setIdValue] = useState("");

  const refreshApps = useCallback(() => {
    fetch(`${API_URL}/v1/apps/mine`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { apps: [] }))
      .then((data) => setApps(data.apps ?? []))
      .catch(() => setApps([]))
      .finally(() => setLoadingApps(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshApps();
  }, [user, refreshApps]);

  if (loading || (user && loadingApps))
    return <><Nav /><div className="container py-16 text-center" style={{ color: "var(--muted)" }}>Loading...</div></>;

  if (!user) {
    return (
      <><Nav />
        <main className="container py-16 text-center" style={{ maxWidth: 600, margin: "0 auto" }}>
          <h1 className="text-3xl font-extrabold mb-3">Publish</h1>
          <p className="mb-6" style={{ color: "var(--muted)" }}>Sign in with GitHub to publish apps to FreeAppStore.</p>
          <button onClick={signIn} className="px-6 py-3 rounded-full font-semibold text-white" style={{ background: "var(--accent)" }}>Sign in with GitHub</button>
        </main>
      </>
    );
  }

  async function handlePublish(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPublishing(true);
    setResult(null);
    setError(null);
    const form = new FormData(e.currentTarget);
    // Map the form to the backend /v1/publish contract. The store is apps-only
    // (FGS publishes go through admin.freegamestore.online); the admin Worker
    // assigns the storefront icon, so there's no icon field here.
    const payload = {
      name: String(form.get("id") ?? ""),
      store: "apps",
      category: String(form.get("category") ?? ""),
      type: String(form.get("type") ?? "standalone"),
      oneliner: String(form.get("oneliner") ?? ""),
      description: String(form.get("description") ?? ""),
      repo: null,
      demo: null,
    };
    try {
      const res = await fetch(`${API_URL}/v1/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.hint || data.error || `Publish failed (HTTP ${res.status})`);
      } else {
        setResult(data as PublishResult);
        refreshApps();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <><Nav />
      <main className="container py-8" style={{ maxWidth: 600, margin: "0 auto" }}>
        <h1 className="text-2xl font-extrabold mb-1">Publish</h1>
        <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
          Signed in as <strong>@{user.login}</strong>
        </p>

        {/* Your Apps */}
        <h2 className="text-lg font-bold mb-3" style={{ color: "var(--accent)" }}>Your Apps</h2>
        {apps.length ? (
          <div className="flex flex-col gap-2 mb-8">
            {apps.map((app) => (
              <div key={app.id} className="p-4 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
                <strong>{app.id}</strong>
                {app.oneliner && <span className="text-sm" style={{ color: "var(--muted)" }}> — {app.oneliner}</span>}
                <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{app.category} · {app.type}</div>
                <div className="flex gap-3 mt-2">
                  <a href={app.appUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold" style={{ color: "var(--accent)" }}>Visit</a>
                  <a href={app.repoUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold" style={{ color: "var(--accent)" }}>Code</a>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mb-8 text-sm" style={{ color: "var(--muted)" }}>No apps yet. Create your first one below!</p>
        )}

        {/* Create New */}
        <h2 className="text-lg font-bold mb-3" style={{ color: "var(--accent)" }}>Create &amp; Publish</h2>
        <form onSubmit={handlePublish} className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-semibold mb-1 block" style={{ color: "var(--muted)" }}>
              Unique ID — becomes your URL
            </label>
            <input name="id" placeholder="e.g. meditation-timer" required className="p-2 rounded-lg border w-full font-mono" style={{ background: "var(--panel)", borderColor: idError ? "var(--error)" : "var(--line)", color: "var(--ink)" }} onChange={(e) => { setIdValue(e.target.value); setIdError(validateId(e.target.value)); }} />
            {idError ? (
              <p className="text-xs mt-1" style={{ color: "var(--error)" }}>{idError}</p>
            ) : idValue && (
              <p className="text-xs mt-1 font-mono" style={{ color: "var(--success)" }}>{idValue}.freeappstore.online</p>
            )}
          </div>
          <select name="type" defaultValue="standalone" className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }}>
            <option value="standalone">Standalone (self-contained)</option>
            <option value="connected">Connected (uses the platform SDK)</option>
          </select>
          <select name="category" required defaultValue="" className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }}>
            <option value="" disabled>Choose a category…</option>
            {CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
          </select>
          <input name="oneliner" placeholder="One-line tagline, e.g. A calm meditation timer" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
          <input name="description" placeholder="Longer description" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
          <button type="submit" disabled={publishing || !!idError} className="p-3 rounded-lg font-semibold text-white" style={{ background: "var(--accent)", opacity: (publishing || idError) ? 0.6 : 1 }}>
            {publishing ? "Provisioning..." : "Create & Publish"}
          </button>
        </form>

        {/* Result */}
        {error && <p className="mt-4 text-sm" style={{ color: "var(--error)" }}>{error}</p>}
        {result && (
          <div className="mt-4 flex flex-col gap-1 text-sm font-mono">
            {result.admin?.steps?.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span style={{ color: s.status === "ok" ? "var(--success)" : s.status === "skip" ? "var(--warning)" : "var(--error)" }}>●</span>
                <span><strong>{s.name}</strong>{s.detail ? `: ${s.detail}` : ""}</span>
              </div>
            ))}
            <p className="mt-3 font-semibold" style={{ color: "var(--success)" }}>
              Published! <a href={result.appUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{result.appUrl}</a>
            </p>
          </div>
        )}
      </main>
    </>
  );
}

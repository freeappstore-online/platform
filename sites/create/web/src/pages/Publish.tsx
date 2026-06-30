import { useState, useEffect } from "react";
import { Nav } from "../components/Nav";
import { useAuth } from "../hooks/useAuth";

const PUBLISH_API = "https://publish.freeappstore.online";

interface CreatorApp {
  id: string;
  store: string;
  name: string;
  createdAt: string;
}

interface CreatorInfo {
  user: string;
  creator: {
    github: string;
    apps: CreatorApp[];
    banned: boolean;
    maxApps: number;
  };
}

interface ProvisionStep {
  name: string;
  status: string;
  detail: string;
}

function validateId(id: string): string | null {
  if (!id) return null; // don't show error on empty (required handles it)
  if (id.length > 58) return "Max 58 characters";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id)) return "Lowercase letters, numbers, dashes only. No start/end dash.";
  if (id.startsWith("free") || id.startsWith("pro")) return "Cannot start with 'free' or 'pro'";
  return null;
}

export function Publish() {
  const { user, loading, signIn } = useAuth();
  const [creator, setCreator] = useState<CreatorInfo | null>(null);
  const [loadingCreator, setLoadingCreator] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<{ steps: ProvisionStep[]; success: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [idValue, setIdValue] = useState("");
  const [store, setStore] = useState("apps");

  useEffect(() => {
    if (!user) return;
    fetch(`${PUBLISH_API}/api/me`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => { setCreator(data); setLoadingCreator(false); })
      .catch(() => setLoadingCreator(false));
  }, [user]);

  if (loading || loadingCreator) return <><Nav /><div className="container py-16 text-center" style={{ color: "var(--muted)" }}>Loading...</div></>;

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

  const c = creator?.creator;
  const remaining = (c?.maxApps || 5) - (c?.apps?.length || 0);

  async function handlePublishExisting(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPublishing(true);
    setResult(null);
    setError(null);
    const form = new FormData(e.currentTarget);
    const body = Object.fromEntries(form);
    try {
      const res = await fetch(`${PUBLISH_API}/api/publish-existing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); }
      else {
        setResult(data);
        fetch(`${PUBLISH_API}/api/me`, { credentials: "include" })
          .then((r) => r.json())
          .then(setCreator)
          .catch(() => {});
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPublishing(false);
    }
  }

  async function handlePublish(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPublishing(true);
    setResult(null);
    setError(null);
    const form = new FormData(e.currentTarget);
    const body = Object.fromEntries(form);
    try {
      const res = await fetch(`${PUBLISH_API}/api/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); }
      else {
        setResult(data);
        // Refresh creator info to show the new app in "Your Apps"
        fetch(`${PUBLISH_API}/api/me`, { credentials: "include" })
          .then((r) => r.json())
          .then(setCreator)
          .catch(() => {});
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
          Signed in as <strong>@{creator?.user}</strong> ·{" "}
          <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: remaining > 0 ? "color-mix(in srgb, var(--success) 15%, var(--panel))" : "color-mix(in srgb, var(--warning) 15%, var(--panel))", color: remaining > 0 ? "var(--success)" : "var(--warning)" }}>
            {remaining} of {c?.maxApps || 5} slots
          </span>
        </p>

        {/* Your Apps */}
        <h2 className="text-lg font-bold mb-3" style={{ color: "var(--accent)" }}>Your Apps</h2>
        {c?.apps?.length ? (
          <div className="flex flex-col gap-2 mb-8">
            {c.apps.map((app) => (
              <div key={app.id} className="p-4 rounded-xl border" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
                <strong>{app.name}</strong> <span className="text-sm" style={{ color: "var(--muted)" }}>({app.id})</span>
                <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{app.store} · {app.createdAt}</div>
                <div className="flex gap-3 mt-2">
                  <a href={`https://${app.id}.${app.store === "apps" ? "freeappstore" : "freegamestore"}.online`} target="_blank" className="text-xs font-semibold" style={{ color: "var(--accent)" }}>Visit</a>
                  <a href={`https://github.com/${app.store === "apps" ? "freeappstore-online" : "freegamestore-online"}/${app.id}`} target="_blank" className="text-xs font-semibold" style={{ color: "var(--accent)" }}>Code</a>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mb-8 text-sm" style={{ color: "var(--muted)" }}>No apps yet. Create your first one below!</p>
        )}

        {/* Create New */}
        <h2 className="text-lg font-bold mb-3" style={{ color: "var(--accent)" }}>Create New</h2>
        {c?.banned ? (
          <p style={{ color: "var(--error)" }}>Your account has been suspended.</p>
        ) : remaining <= 0 ? (
          <p style={{ color: "var(--warning)" }}>You've used all your slots.</p>
        ) : (
          <form onSubmit={handlePublish} className="flex flex-col gap-3">
            <select name="store" value={store} onChange={(e) => setStore(e.target.value)} className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }}>
              <option value="apps">App (freeappstore.online)</option>
              <option value="games">Game (freegamestore.online)</option>
            </select>
            <div>
              <label className="text-xs font-semibold mb-1 block" style={{ color: "var(--muted)" }}>
                Unique ID — becomes your URL
              </label>
              <input name="id" placeholder="e.g. meditation-timer" required className="p-2 rounded-lg border w-full font-mono" style={{ background: "var(--panel)", borderColor: idError ? "var(--error)" : "var(--line)", color: "var(--ink)" }} onChange={(e) => { setIdValue(e.target.value); setIdError(validateId(e.target.value)); }} />
              {idError ? (
                <p className="text-xs mt-1" style={{ color: "var(--error)" }}>{idError}</p>
              ) : idValue && (
                <p className="text-xs mt-1 font-mono" style={{ color: "var(--success)" }}>
                  {idValue}.{store === "games" ? "freegamestore" : "freeappstore"}.online
                </p>
              )}
            </div>
            <input name="name" placeholder="Display name, e.g. Meditation Timer" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
            <input name="category" placeholder="Category, e.g. utilities" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
            <input name="icon" placeholder="Icon HTML entity, e.g. &#128197;" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
            <input name="iconBg" placeholder="Icon bg color" defaultValue="#f0f9ff" className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
            <input name="description" placeholder="One-line description" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
            <button type="submit" disabled={publishing || !!idError} className="p-3 rounded-lg font-semibold text-white" style={{ background: "var(--accent)", opacity: (publishing || idError) ? 0.6 : 1 }}>
              {publishing ? "Provisioning..." : "Create & Publish"}
            </button>
          </form>
        )}

        {/* Publish Existing */}
        {!c?.banned && remaining > 0 && (
          <>
            <h2 className="text-lg font-bold mb-1 mt-8" style={{ color: "var(--accent)" }}>Publish Existing App</h2>
            <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
              Already deployed on CF Pages? Add it to the store without creating a new repo.
            </p>
            <form onSubmit={handlePublishExisting} className="flex flex-col gap-3">
              <select name="store" className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }}>
                <option value="apps">App (freeappstore.online)</option>
                <option value="games">Game (freegamestore.online)</option>
              </select>
              <input name="pagesProject" placeholder="CF Pages project name, e.g. hello-world-greeter" required className="p-2 rounded-lg border font-mono" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
              <input name="id" placeholder="Store ID, e.g. hello-world" required className="p-2 rounded-lg border font-mono" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
              <input name="name" placeholder="Display name, e.g. Hello World" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
              <input name="category" placeholder="Category, e.g. utilities" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
              <input name="icon" placeholder="Icon HTML entity, e.g. &#128075;" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
              <input name="iconBg" placeholder="Icon bg color" defaultValue="#f0f9ff" className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
              <input name="description" placeholder="One-line description" required className="p-2 rounded-lg border" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
              <button type="submit" disabled={publishing} className="p-3 rounded-lg font-semibold text-white" style={{ background: "var(--accent)", opacity: publishing ? 0.6 : 1 }}>
                {publishing ? "Publishing..." : "Publish to Store"}
              </button>
            </form>
          </>
        )}

        {/* Result */}
        {error && <p className="mt-4 text-sm" style={{ color: "var(--error)" }}>{error}</p>}
        {result && (
          <div className="mt-4 flex flex-col gap-1 text-sm font-mono">
            {result.steps.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span style={{ color: s.status === "ok" ? "var(--success)" : s.status === "skip" ? "var(--warning)" : "var(--error)" }}>
                  {s.status === "ok" ? "●" : s.status === "skip" ? "●" : "●"}
                </span>
                <span><strong>{s.name}</strong>: {s.detail}</span>
              </div>
            ))}
            {result.success && <p className="mt-3 font-semibold" style={{ color: "var(--success)" }}>Published!</p>}
            {(result as any).audit && (
              <div className="mt-4 p-3 rounded-lg border" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
                <p className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>
                  Auto-audit: {(result as any).audit.pass} pass, {(result as any).audit.fail} fail
                </p>
                {(result as any).audit.checks.map((c: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span style={{ color: c.status === "pass" ? "var(--success)" : c.status === "warn" ? "var(--warning)" : "var(--error)" }}>●</span>
                    <span>{c.name}{c.detail ? ` — ${c.detail}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}

import { useCallback, useState } from "react";
import { getSession } from "../../lib/api";

const PUBLISH_API = "https://api.freeappstore.online/v1";

export interface PublishAudit {
  pass: number;
  fail: number;
}

export function PublishModal({ appId, appName, onClose, onPublished }: {
  appId: string;
  appName: string;
  onClose: () => void;
  onPublished: (url: string, audit: PublishAudit) => void;
}) {
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // The backend uses `name` as the app ID and validates ^[a-z][a-z0-9-]{1,30}$.
  const idValid = /^[a-z][a-z0-9-]{1,30}$/.test(appId);

  const handlePublish = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPublishing(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const oneliner = String(form.get("oneliner") || "").trim();
    const category = String(form.get("category") || "utilities");
    // Match the /v1/publish contract exactly: `name` is the lowercase app id,
    // `oneliner` is what the storefront shows, `type` gates connected features.
    const body = {
      store: "apps",
      name: appId,
      category,
      type: "standalone",
      oneliner,
      description: oneliner,
      repo: null,
      demo: null,
    };
    try {
      const session = getSession();
      const res = await fetch(`${PUBLISH_API}/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      // The endpoint returns plain text on validation errors and JSON on
      // success/structured errors — read text first, then try to parse.
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok || data?.error) {
        setError(data?.hint || data?.error || text || `Publish failed (HTTP ${res.status})`);
        return;
      }
      setResult(data);
      const steps: any[] = data?.admin?.steps || [];
      const audit = { pass: steps.filter((s) => s.status === "ok").length, fail: steps.filter((s) => s.status === "fail").length };
      onPublished(data?.appUrl || `https://${appId}.freeappstore.online`, audit);
    } catch (err) {
      setError(String(err));
    } finally {
      setPublishing(false);
    }
  }, [appId, onPublished]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "var(--panel)", borderRadius: "var(--radius-lg)", padding: "1.5rem", width: "100%", maxWidth: 420, maxHeight: "90vh", overflow: "auto", boxShadow: "var(--shadow-lg)", border: "1px solid var(--line)" }}>
        {result?.appId ? (
          <>
            <h2 className="text-lg font-bold mb-2" style={{ color: "var(--success)" }}>Published!</h2>
            <p className="text-sm mb-2">Your app is live at <a href={result.appUrl || `https://${appId}.freeappstore.online`} target="_blank" rel="noopener" className="font-semibold" style={{ color: "var(--accent)" }}>{appId}.freeappstore.online</a></p>
            {result.admin?.steps?.length > 0 && (
              <div className="text-xs mb-3">
                {result.admin.steps.map((s: any, i: number) => (
                  <div key={i} className="flex items-center gap-1">
                    <span style={{ color: s.status === "ok" ? "var(--success)" : s.status === "skip" ? "var(--muted)" : "var(--danger)" }}>●</span>
                    <span>{s.name}{s.detail ? ` — ${s.detail}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={onClose} className="w-full p-2 rounded-lg font-semibold text-white" style={{ background: "var(--accent)", border: "none", cursor: "pointer" }}>Done</button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold">Publish to Store</h2>
              <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: "1.2rem" }}>✕</button>
            </div>
            <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
              This will add <strong>{appName}</strong> to freeappstore.online with a custom subdomain.
            </p>
            <form onSubmit={handlePublish} className="flex flex-col gap-2">
              <div>
                <label className="text-xs font-semibold" style={{ color: "var(--muted)" }}>URL</label>
                <p className="text-sm font-mono" style={{ color: "var(--accent)" }}>{appId}.freeappstore.online</p>
              </div>
              {!idValid && (
                <p className="text-xs" style={{ color: "var(--danger)" }}>
                  This app's id "{appId}" isn't a valid store id (needs lowercase letters/digits/hyphens, 2–31 chars). Re-deploy with a simpler name first.
                </p>
              )}
              <div>
                <label className="text-xs font-semibold" style={{ color: "var(--muted)" }}>Category</label>
                <select name="category" className="w-full p-2 rounded-lg border text-sm" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }}>
                  <option value="utilities">Utilities</option>
                  <option value="productivity">Productivity</option>
                  <option value="learning">Learning</option>
                  <option value="lifestyle">Lifestyle</option>
                  <option value="finance">Finance</option>
                  <option value="health">Health</option>
                  <option value="creative">Creative</option>
                  <option value="social">Social</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold" style={{ color: "var(--muted)" }}>One-line description</label>
                <input name="oneliner" placeholder="What does it do, in one line?" required className="w-full p-2 rounded-lg border text-sm" style={{ background: "var(--panel)", borderColor: "var(--line)", color: "var(--ink)" }} />
              </div>
              {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
              <button type="submit" disabled={publishing || !idValid} className="p-2 rounded-lg font-semibold text-white text-sm" style={{ background: "var(--accent)", border: "none", cursor: "pointer", opacity: publishing || !idValid ? 0.6 : 1 }}>
                {publishing ? "Publishing..." : "Publish"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

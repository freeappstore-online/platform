import { useCallback, useState } from "react";
import { getSession } from "../../lib/api";
import { summarizeSteps } from "../../../deploy-status";

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

  // The backend uses `name` as the app ID and validates ^[a-z][a-z0-9-]{0,29}[a-z0-9]$.
  const idValid = /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/.test(appId);

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
    <div className="fixed inset-[0px] z-[100] flex items-center justify-center bg-[rgba(0,0,0,0.5)]" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-paper rounded-[var(--radius-lg)] p-[1.5rem] w-[100%] max-w-[420px] max-h-[90vh] overflow-auto shadow-[var(--shadow-lg)] border border-line">
        {result?.appId ? (() => {
          // A 200 from /publish does not mean every provisioning step worked.
          // Show a partial failure as a failure, naming the step (#32).
          const steps = summarizeSteps(result.admin?.steps);
          return (
          <>
            {steps.allOk ? (
              <>
                <h2 className="text-lg font-bold mb-2 text-success">Published!</h2>
                <p className="text-sm mb-2">Your app is live at <a href={result.appUrl || `https://${appId}.freeappstore.online`} target="_blank" rel="noopener" className="font-semibold text-accent">{appId}.freeappstore.online</a></p>
              </>
            ) : (
              <>
                <h2 className="text-lg font-bold mb-2 text-danger">{steps.summary}</h2>
                <p className="text-sm mb-2">The app was created but is not fully set up. These steps failed:</p>
                <ul className="text-sm mb-2 pl-[1.1rem]">
                  {steps.failed.map((s, i) => (
                    <li key={i}><strong>{s.name}</strong>{s.detail ? ` — ${s.detail}` : " — no detail reported"}</li>
                  ))}
                </ul>
                <p className="text-xs mb-2 text-muted">
                  Re-run publish to retry. <a href={`https://github.com/freeappstore-online/${appId}/actions`} target="_blank" rel="noopener" className="text-accent">View Actions</a>
                </p>
              </>
            )}
            {result.admin?.steps?.length > 0 && (
              <div className="text-xs mb-3">
                {result.admin.steps.map((s: any, i: number) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className={`${(s.status === "ok" ? "text-success" : (s.status === "skip" ? "text-muted" : "text-danger"))}`}>●</span>
                    <span>{s.name}{s.detail ? ` — ${s.detail}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={onClose} className="w-full p-2 rounded-lg font-semibold text-white bg-accent border-0 cursor-pointer">Done</button>
          </>
          );
        })() : (
          <>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold">Publish to Store</h2>
              <button onClick={onClose} className="bg-transparent border-0 cursor-pointer text-muted text-[1.2rem]">✕</button>
            </div>
            <p className="text-xs mb-3 text-muted">
              This will add <strong>{appName}</strong> to freeappstore.online with a custom subdomain.
            </p>
            <form onSubmit={handlePublish} className="flex flex-col gap-2">
              <div>
                <label className="text-xs font-semibold text-muted">URL</label>
                <p className="text-sm font-mono text-accent">{appId}.freeappstore.online</p>
              </div>
              {!idValid && (
                <p className="text-xs text-danger">
                  This app's id "{appId}" isn't a valid store id (needs lowercase letters/digits/hyphens, 2–31 chars). Re-deploy with a simpler name first.
                </p>
              )}
              <div>
                <label className="text-xs font-semibold text-muted">Category</label>
                <select name="category" className="w-full p-2 rounded-lg border text-sm bg-panel border-line text-ink">
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
                <label className="text-xs font-semibold text-muted">One-line description</label>
                <input name="oneliner" placeholder="What does it do, in one line?" required className="w-full p-2 rounded-lg border text-sm bg-panel border-line text-ink"  />
              </div>
              {error && <p className="text-xs text-danger">{error}</p>}
              <button type="submit" disabled={publishing || !idValid} className={`p-2 rounded-lg font-semibold text-white text-sm bg-accent border-0 cursor-pointer ${(publishing || !idValid ? "opacity-[0.6]" : "opacity-[1]")}`} >
                {publishing ? "Publishing..." : "Publish"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

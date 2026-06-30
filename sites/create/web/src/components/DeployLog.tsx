/** Deploy pipeline — progress bar + step list with spinner */

const DEPLOY_PIPELINE = [
  { key: "repo", label: "GitHub repo", phases: ["provisioning"] },
  { key: "cf", label: "CF Pages", phases: ["provisioning"] },
  { key: "push", label: "Pushing code", phases: ["pushing"] },
  { key: "build", label: "Building", phases: ["building"] },
  { key: "live", label: "Preview ready", phases: ["live"] },
];

const PHASE_ORDER = ["provisioning", "pushing", "building", "live"];

interface DeployState {
  phase: string;
  steps?: { name: string; status: string }[];
  appUrl?: string;
  error?: string;
}

type StepStatus = "done" | "active" | "skip" | "fail" | "pending";

function getStepStatus(step: typeof DEPLOY_PIPELINE[0], state: DeployState, phaseIdx: number): StepStatus {
  const provStep = state.steps?.find((s) => s.name === step.label);
  if (provStep) return provStep.status === "ok" ? "done" : provStep.status === "skip" ? "skip" : "fail";
  if (state.phase === "live") return "done";
  if (state.phase === "error") {
    const idx = PHASE_ORDER.findIndex((p) => step.phases.includes(p));
    return idx < phaseIdx ? "done" : idx === phaseIdx ? "fail" : "pending";
  }
  const idx = PHASE_ORDER.findIndex((p) => step.phases.includes(p));
  return idx < phaseIdx ? "done" : idx === phaseIdx ? "active" : "pending";
}

export function DeployLog({ state }: { state: DeployState }) {
  const phaseIdx = PHASE_ORDER.indexOf(state.phase);
  const statuses = DEPLOY_PIPELINE.map((step) => getStepStatus(step, state, phaseIdx));
  const doneCount = statuses.filter((s) => s === "done" || s === "skip").length;
  const percentage = state.phase === "live" ? 100 : state.phase === "error"
    ? Math.round((doneCount / DEPLOY_PIPELINE.length) * 100)
    : Math.round(((doneCount + 0.5) / DEPLOY_PIPELINE.length) * 100); // +0.5 for active step

  return (
    <div className="w-full p-6 flex flex-col items-center justify-center" style={{ fontSize: "0.85rem" }}>
      {/* Circular progress */}
      <div style={{ position: "relative", width: 120, height: 120, marginBottom: "1.5rem" }}>
        <svg width={120} height={120} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={60} cy={60} r={52} fill="none" stroke="var(--line)" strokeWidth={6} />
          <circle
            cx={60} cy={60} r={52} fill="none"
            stroke={state.phase === "error" ? "#dc2626" : state.phase === "live" ? "#16a34a" : "var(--accent)"}
            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 52}
            strokeDashoffset={2 * Math.PI * 52 * (1 - percentage / 100)}
            style={{ transition: "stroke-dashoffset 0.5s ease" }}
          />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          {state.phase === "live" ? (
            <span style={{ fontSize: "2rem" }}>🎉</span>
          ) : state.phase === "error" ? (
            <span style={{ fontSize: "1.5rem", color: "#dc2626" }}>✗</span>
          ) : (
            <>
              <span style={{ fontSize: "1.5rem", fontWeight: 800, color: "var(--ink)" }}>{percentage}%</span>
              <span style={{ fontSize: "0.65rem", color: "var(--muted)" }}>deploying</span>
            </>
          )}
        </div>
      </div>

      {/* Step list */}
      <div className="w-full flex flex-col gap-0.5" style={{ maxWidth: 280 }}>
        {DEPLOY_PIPELINE.map((step, i) => {
          const status = statuses[i];
          const icon = { done: "✓", skip: "⊘", fail: "✗", active: "", pending: "" }[status];
          const iconColor = { done: "#16a34a", skip: "#d97706", fail: "#dc2626", active: "var(--accent)", pending: "var(--line-strong)" }[status];

          return (
            <div key={step.key} className="flex items-center gap-2 py-1 px-2 rounded-md" style={{
              color: status === "fail" ? "#dc2626" : ["done", "active"].includes(status) ? "var(--ink)" : "var(--muted)",
              fontWeight: status === "active" ? 600 : 400,
              fontSize: "0.82rem",
            }}>
              {status === "active" ? (
                <span style={{ width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ width: 10, height: 10, border: "2px solid var(--accent)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.6s linear infinite", display: "block" }} />
                </span>
              ) : (
                <span style={{ width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", color: iconColor, fontWeight: 700 }}>
                  {icon || "○"}
                </span>
              )}
              {step.label}
              {status === "skip" && <span className="text-xs ml-1" style={{ color: "var(--muted)" }}>(exists)</span>}
            </div>
          );
        })}
      </div>

      {/* Result banners */}
      {state.phase === "live" && state.appUrl && (
        <div className="w-full mt-4 p-3 rounded-xl text-center" style={{ background: "color-mix(in srgb, #16a34a 10%, var(--panel))", border: "1px solid color-mix(in srgb, #16a34a 25%, var(--line))", maxWidth: 280 }}>
          <div className="font-bold text-sm" style={{ color: "#16a34a" }}>Preview is live!</div>
          <a href={state.appUrl} target="_blank" rel="noopener" className="text-xs" style={{ color: "#16a34a" }}>{state.appUrl.replace("https://", "")}</a>
          <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>Publish to store when ready.</div>
        </div>
      )}

      {state.phase === "error" && (
        <div className="w-full mt-4 p-3 rounded-xl" style={{ background: "color-mix(in srgb, #dc2626 8%, var(--panel))", border: "1px solid color-mix(in srgb, #dc2626 25%, var(--line))", maxWidth: 280 }}>
          <div className="font-bold text-sm mb-1" style={{ color: "#dc2626" }}>Deploy failed</div>
          <pre className="text-xs whitespace-pre-wrap" style={{ color: "var(--muted)" }}>{state.error?.slice(0, 300)}</pre>
        </div>
      )}
    </div>
  );
}

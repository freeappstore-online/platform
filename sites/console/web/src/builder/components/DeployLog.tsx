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
    <div className="w-full p-6 flex flex-col items-center justify-center text-[0.85rem]">
      {/* Circular progress */}
      <div className="relative w-[120px] h-[120px] mb-6">
        <svg width={120} height={120} className="-rotate-90">
          <circle cx={60} cy={60} r={52} fill="none" className="stroke-line" strokeWidth={6} />
          <circle
            cx={60} cy={60} r={52} fill="none"

            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 52}
            strokeDashoffset={2 * Math.PI * 52 * (1 - percentage / 100)}
            className={`transition-[stroke-dashoffset] duration-500 ease-[ease] ${state.phase === "error" ? "stroke-danger" : state.phase === "live" ? "stroke-success" : "stroke-accent"}`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {state.phase === "live" ? (
            <span className="text-[2rem]">🎉</span>
          ) : state.phase === "error" ? (
            <span className="text-2xl text-danger">✗</span>
          ) : (
            <>
              <span className="text-2xl font-extrabold text-ink">{percentage}%</span>
              <span className="text-[0.65rem] text-muted">deploying</span>
            </>
          )}
        </div>
      </div>

      {/* Step list */}
      <div className="w-full flex flex-col gap-0.5 max-w-[280px]">
        {DEPLOY_PIPELINE.map((step, i) => {
          const status = statuses[i];
          const icon = { done: "✓", skip: "⊘", fail: "✗", active: "", pending: "" }[status];
          const iconClass = { done: "text-success", skip: "text-warning", fail: "text-danger", active: "text-accent", pending: "text-(--line-strong)" }[status];

          return (
            <div key={step.key} className={`flex items-center gap-2 py-1 px-2 rounded-md text-[0.82rem] ${status === "fail" ? "text-danger" : ["done", "active"].includes(status) ? "text-ink" : "text-muted"} ${status === "active" ? "font-semibold" : "font-normal"}`}>
              {status === "active" ? (
                <span className="w-4 h-4 flex items-center justify-center">
                  <span className="w-2.5 h-2.5 border-2 border-accent border-t-transparent rounded-full animate-spin [animation-duration:0.6s] block" />
                </span>
              ) : (
                <span className={`w-4 h-4 flex items-center justify-center text-[0.7rem] font-bold ${iconClass}`}>
                  {icon || "○"}
                </span>
              )}
              {step.label}
              {status === "skip" && <span className="text-xs ml-1 text-muted">(exists)</span>}
            </div>
          );
        })}
      </div>

      {/* Result banners */}
      {state.phase === "live" && state.appUrl && (
        <div className="w-full mt-4 p-3 rounded-xl text-center bg-[color-mix(in_srgb,var(--success)_10%,var(--panel))] border border-[color-mix(in_srgb,var(--success)_25%,var(--line))] max-w-[280px]">
          <div className="font-bold text-sm text-success">Preview is live!</div>
          <a href={state.appUrl} target="_blank" rel="noopener" className="text-xs text-success">{state.appUrl.replace("https://", "")}</a>
          <div className="text-xs mt-1 text-muted">Publish to store when ready.</div>
        </div>
      )}

      {state.phase === "error" && (
        <div className="w-full mt-4 p-3 rounded-xl bg-[color-mix(in_srgb,var(--danger)_8%,var(--panel))] border border-[color-mix(in_srgb,var(--danger)_25%,var(--line))] max-w-[280px]">
          <div className="font-bold text-sm mb-1 text-danger">Deploy failed</div>
          <pre className="text-xs whitespace-pre-wrap text-muted">{state.error?.slice(0, 300)}</pre>
        </div>
      )}
    </div>
  );
}

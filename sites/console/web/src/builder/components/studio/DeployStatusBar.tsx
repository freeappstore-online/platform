/** Deployment status bar — sits between the URL bar and the preview body. */
import { useEffect, useState } from "react";
import type { DeployState, AIConfig } from "../../hooks/useAgent";

// ── Types ─────────────────────────────────────────────────────────────────────

type BarState = "idle" | "working" | "deploying" | "live" | "error";

function deriveBarState(isStreaming: boolean, deployState: DeployState | null): BarState {
  if (deployState?.phase === "error") return "error";
  if (deployState?.phase === "live") return "live";
  const deploying =
    deployState?.phase && !["live", "error"].includes(deployState.phase);
  if (deploying) return "deploying";
  if (isStreaming) return "working";
  return "idle";
}

function phaseLabel(deployState: DeployState | null): string {
  if (!deployState) return "";
  switch (deployState.phase) {
    case "provisioning": {
      const steps = deployState.steps ?? [];
      const active = steps.find((s) => s.status === "active" || s.status === "running");
      return active ? active.name : "Setting up…";
    }
    case "pushing":
      return "Pushing code…";
    case "building":
      return "Building…";
    default:
      return "";
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface DeployStatusBarProps {
  isStreaming: boolean;
  deployState: DeployState | null;
  appId?: string;
  onRetry: (message: string, config: AIConfig) => void;
  retryConfig: AIConfig;
  onSwitchToChat: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DeployStatusBar({
  isStreaming,
  deployState,
  appId,
  onRetry,
  retryConfig,
  onSwitchToChat,
}: DeployStatusBarProps) {
  const barState = deriveBarState(isStreaming, deployState);
  const [expanded, setExpanded] = useState(false);
  // Auto-hide after 4 s in "live" state
  const [hideLive, setHideLive] = useState(false);

  useEffect(() => {
    if (barState === "live") {
      setHideLive(false);
      const t = setTimeout(() => setHideLive(true), 4000);
      return () => clearTimeout(t);
    }
    setHideLive(false);
  }, [barState]);

  // Collapse the error panel when a new message starts (barState goes to working)
  useEffect(() => {
    if (barState === "working") setExpanded(false);
  }, [barState]);

  if (barState === "idle" || (barState === "live" && hideLive)) return null;

  // ── Visual config per state ──────────────────────────────────────────────
  const stateConfig: Record<
    Exclude<BarState, "idle">,
    { label: string; dot: string; detail: string }
  > = {
    working: {
      label: "Building",
      dot: "bg-warning",
      detail: "Generating app code…",
    },
    deploying: {
      label: "Deploying",
      dot: "bg-accent",
      detail: phaseLabel(deployState),
    },
    live: {
      label: "Live",
      dot: "bg-success",
      detail: "Preview ready",
    },
    error: {
      label: "Deploy failed",
      dot: "bg-danger",
      detail: deployState?.error?.slice(0, 80) ?? "Check the error panel for details.",
    },
  };

  const cfg = stateConfig[barState as Exclude<BarState, "idle">];
  const isPulsing = barState === "working" || barState === "deploying";

  const handleRetry = () => {
    const errorContext = deployState?.error ?? "unknown error";
    const retryMsg = `The last deploy failed with the following error. Please fix the issue and redeploy:\n\n\`\`\`\n${errorContext}\n\`\`\``;
    setExpanded(false);
    onSwitchToChat();
    onRetry(retryMsg, retryConfig);
  };

  return (
    <>
      {/* Status strip */}
      <div
        className={`flex items-center gap-2 shrink-0 text-xs py-[0.3rem] px-3 border-b border-line min-h-7 ${barState === "error" ? "bg-[color-mix(in_srgb,var(--danger)_8%,var(--panel))]" : barState === "live" ? "bg-[color-mix(in_srgb,var(--success)_8%,var(--panel))]" : "bg-panel"}`}
      >
        {/* Dot indicator */}
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot} ${isPulsing ? "animate-pulse [animation-duration:1.4s]" : ""}`}
        />
        {/* Label */}
        <span
          className={`font-semibold ${barState === "error" ? "text-danger" : barState === "live" ? "text-success" : "text-ink"}`}
        >
          {cfg.label}
        </span>
        {/* Detail */}
        {cfg.detail && (
          <span className="truncate text-muted min-w-0 flex-1">
            {cfg.detail}
          </span>
        )}
        {/* Expand chevron (error only) */}
        {barState === "error" && (
          <button
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? "Collapse error details" : "Expand error details"}
            className="bg-transparent border-0 cursor-pointer text-muted text-base flex items-center p-[0_0.25rem] shrink-0"
          >
            {expanded ? "∧" : "∨"}
          </button>
        )}
      </div>


      {/* Expanded error panel */}
      {barState === "error" && expanded && (
        <div
          className="shrink-0 flex flex-col gap-2 p-[0.75rem] border-b border-line bg-[color-mix(in_srgb,_var(--danger)_5%,_var(--panel))] text-[0.8rem]"
        >
          {/* Error label */}
          <div className="font-semibold text-xs text-danger">
            What happened
          </div>
          {/* Error text */}
          <pre
            className="rounded-lg overflow-auto text-xs whitespace-pre-wrap max-h-[200px] p-[0.6rem_0.75rem] bg-paper border border-line text-ink font-[monospace] leading-[1.5]"
          >
            {(deployState?.error ?? "No error details available.").slice(0, 2000)}
          </pre>
          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleRetry}
              className="inline-flex items-center gap-1 font-semibold p-[0.35rem_0.75rem] bg-accent text-white border-0 rounded-control-sm cursor-pointer text-[0.8rem]"
            >
              {"↺"} Ask agent to fix this
            </button>
            {appId && (
              <a
                href={`https://github.com/freeappstore-online/${appId}/actions`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold p-[0.35rem_0.75rem] bg-transparent text-muted border border-line rounded-control-sm no-underline text-[0.8rem]"
              >
                Open build logs {"↗"}
              </a>
            )}
          </div>
        </div>
      )}
    </>
  );
}

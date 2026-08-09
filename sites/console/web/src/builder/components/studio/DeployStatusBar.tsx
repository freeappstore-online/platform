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
      dot: "#f59e0b", // amber
      detail: "Generating app code…",
    },
    deploying: {
      label: "Deploying",
      dot: "#3b82f6", // blue
      detail: phaseLabel(deployState),
    },
    live: {
      label: "Live",
      dot: "#16a34a", // green
      detail: "Preview ready",
    },
    error: {
      label: "Deploy failed",
      dot: "#dc2626", // red
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
        className="flex items-center gap-2 shrink-0 text-xs"
        style={{
          padding: "0.3rem 0.75rem",
          borderBottom: "1px solid var(--line)",
          background:
            barState === "error"
              ? "color-mix(in srgb, #dc2626 8%, var(--panel))"
              : barState === "live"
              ? "color-mix(in srgb, #16a34a 8%, var(--panel))"
              : "var(--panel)",
          minHeight: 28,
        }}
      >
        {/* Dot indicator */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: cfg.dot,
            flexShrink: 0,
            animation: isPulsing ? "fas-pulse 1.4s ease-in-out infinite" : "none",
          }}
        />
        {/* Label */}
        <span
          className="font-semibold"
          style={{
            color:
              barState === "error"
                ? "#dc2626"
                : barState === "live"
                ? "#16a34a"
                : "var(--ink)",
          }}
        >
          {cfg.label}
        </span>
        {/* Detail */}
        {cfg.detail && (
          <span className="truncate" style={{ color: "var(--muted)", minWidth: 0, flex: 1 }}>
            {cfg.detail}
          </span>
        )}
        {/* Expand chevron (error only) */}
        {barState === "error" && (
          <button
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? "Collapse error details" : "Expand error details"}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--muted)",
              fontSize: "1rem",
              display: "flex",
              alignItems: "center",
              padding: "0 0.25rem",
              flexShrink: 0,
            }}
          >
            {expanded ? "∧" : "∨"}
          </button>
        )}
      </div>

      {/* Pulse keyframes — injected once via a <style> tag */}
      <style>{`
        @keyframes fas-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>

      {/* Expanded error panel */}
      {barState === "error" && expanded && (
        <div
          className="shrink-0 flex flex-col gap-2"
          style={{
            padding: "0.75rem",
            borderBottom: "1px solid var(--line)",
            background: "color-mix(in srgb, #dc2626 5%, var(--panel))",
            fontSize: "0.8rem",
          }}
        >
          {/* Error label */}
          <div className="font-semibold text-xs" style={{ color: "#dc2626" }}>
            What happened
          </div>
          {/* Error text */}
          <pre
            className="rounded-lg overflow-auto text-xs whitespace-pre-wrap"
            style={{
              maxHeight: 200,
              padding: "0.6rem 0.75rem",
              background: "var(--paper)",
              border: "1px solid var(--line)",
              color: "var(--ink)",
              fontFamily: "monospace",
              lineHeight: 1.5,
            }}
          >
            {(deployState?.error ?? "No error details available.").slice(0, 2000)}
          </pre>
          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleRetry}
              className="inline-flex items-center gap-1 font-semibold"
              style={{
                padding: "0.35rem 0.75rem",
                background: "var(--accent)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius-sm)",
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
            >
              {"↺"} Ask agent to fix this
            </button>
            {appId && (
              <a
                href={`https://github.com/freeappstore-online/${appId}/actions`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold"
                style={{
                  padding: "0.35rem 0.75rem",
                  background: "none",
                  color: "var(--muted)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius-sm)",
                  textDecoration: "none",
                  fontSize: "0.8rem",
                }}
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

import { useState } from "react";
import type { Agent } from "../../hooks/useAgent";

/** Copies the current conversation as JSON — handy for bug reports. */
export function CopyLogButton({ agent, provider, model }: { agent: Agent; provider: string; model: string }) {
  const [copied, setCopied] = useState(false);
  const btn: React.CSSProperties = { background: "none", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", minWidth: 40, minHeight: 40, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: copied ? "var(--success)" : "var(--muted)", fontSize: "0.9rem" };

  async function copy() {
    const json = JSON.stringify({
      project: agent.projects.find((p) => p.id === agent.currentProjectId)?.name || "unknown",
      sessionId: agent.currentProjectId,
      provider, model,
      tokens: { input: agent.tokensIn, output: agent.tokensOut },
      messages: agent.messages,
      exportedAt: new Date().toISOString(),
    }, null, 2);
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return <button onClick={copy} title="Copy conversation as JSON" style={btn}>{copied ? "✓" : "📋"}</button>;
}

import { useState } from "react";
import type { Agent } from "../../hooks/useAgent";

/** Copies the current conversation as JSON — handy for bug reports. */
export function CopyLogButton({ agent, provider, model }: { agent: Agent; provider: string; model: string }) {
  const [copied, setCopied] = useState(false);

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

  return <button onClick={copy} title="Copy conversation as JSON" className={`inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center rounded-control-sm border border-line bg-transparent text-[0.9rem] ${copied ? "text-success" : "text-muted"}`}>{copied ? "✓" : "📋"}</button>;
}

type AgentStatus = {
  appId?: string | null;
  appUrl?: string | null;
  deployStatus?: { phase?: string; error?: string } | null;
  messageCount?: number;
  devStatus?: { state?: string; detail?: string } | null;
};

type ActivityToolResult = { id: string; content?: string; isError?: boolean };

type ActivityMessage = {
  role: string;
  content?: string;
  toolCalls?: Array<{ id?: string; name: string; input?: { path?: string; id?: string } }>;
  toolResults?: ActivityToolResult[];
};

function safeSummary(value: string, limit: number): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|AKIA)[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, limit);
}

export function formatAgentStatus(sessionId: string, status: AgentStatus): string {
  const state = status.devStatus?.state ?? "unknown";
  const detail = status.devStatus?.detail ? ` — ${safeSummary(status.devStatus.detail, 200)}` : "";
  const lines = [
    `Session **${sessionId}**`,
    `Status: ${state}${detail}`,
    `App: ${status.appId ?? "(not deployed yet)"}`,
    `Deploy phase: ${status.deployStatus?.phase ?? "—"}${status.deployStatus?.error ? ` (${safeSummary(status.deployStatus.error, 200)})` : ""}`,
    status.appUrl ? `Live: ${status.appUrl}` : status.appId ? `URL (once live): https://${status.appId}.freeappstore.online` : "",
    `Messages: ${status.messageCount ?? 0}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function isReportedError(result: ActivityToolResult): boolean {
  return result.isError === true || /^(?:error\b|deploy failed\b|build check failed\b|compliance check failed\b|tool .+ threw an error\b)/i.test(result.content ?? "");
}

function renderToolResults(message: ActivityMessage, callsById: Map<string, string>): string {
  const results = message.toolResults ?? [];
  if (!results.length) return "[tool result] No result details recorded.";
  return results.map((result) => {
    const name = callsById.get(result.id);
    const outcome = isReportedError(result) ? "reported an error" : "completed";
    return `[tool result] ${name ?? "Tool"}: ${outcome}`;
  }).join("\n");
}

export function formatAgentActivity(
  sessionId: string,
  messages: ActivityMessage[],
  limit = 30,
  appName?: string | null,
): string {
  if (!messages.length) return `Session **${sessionId}**: no messages yet.`;
  const recent = messages.slice(-limit);
  const callsById = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) if (call.id) callsById.set(call.id, call.name);
  }
  const rendered = recent.map((message) => {
    if (message.toolCalls?.length) {
      const calls = message.toolCalls.map((call) => {
        const target = call.input?.path ?? call.input?.id;
        return `${call.name}${target ? `(${safeSummary(target, 120)})` : ""}`;
      }).join(", ");
      return `[agent → tools] ${calls}`;
    }
    if (message.role === "tool_result") return renderToolResults(message, callsById);
    if (message.role === "tool") return "[tool result] Outcome recorded.";
    return `**${safeSummary(message.role, 40)}:** ${(message.content ?? "").slice(0, 1200)}`;
  }).join("\n\n");
  return `Session **${sessionId}**${appName ? ` — ${safeSummary(appName, 100)}` : ""} (${messages.length} messages, showing ${recent.length}):\n\n${rendered}`;
}

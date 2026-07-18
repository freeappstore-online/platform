/** Chat message bubble — user, assistant, tool, or system.
 *  User/assistant bubbles get Speak + Copy actions beneath the content. */

import { useState } from "react";
import { Markdown } from "./Markdown";

const STYLES: Record<string, React.CSSProperties> = {
  user: { alignSelf: "flex-end", background: "var(--accent)", color: "white", borderBottomRightRadius: "0.15rem" },
  assistant: { alignSelf: "flex-start", background: "var(--panel)", border: "1px solid var(--line)", borderBottomLeftRadius: "0.15rem" },
  tool: { alignSelf: "flex-start", fontSize: "0.72rem", fontFamily: "monospace", background: "var(--panel)", border: "1px solid var(--line)", color: "var(--muted)", padding: "0.25rem 0.5rem", borderRadius: "0.35rem" },
  system: { alignSelf: "center", fontSize: "0.78rem", color: "var(--muted)", background: "none" },
};

interface Props {
  role: string;
  content: string;
  canSpeak?: boolean;   // speechSynthesis available
  speaking?: boolean;   // this message is currently being spoken
  onSpeak?: () => void;
}

export function ChatMessage({ role, content, canSpeak, speaking, onSpeak }: Props) {
  const [copied, setCopied] = useState(false);
  const useMarkdown = role === "assistant";
  const showActions = (role === "user" || role === "assistant") && content.trim().length > 0;
  const onAccent = role === "user"; // white text bubble → actions need light color

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked — ignore */ }
  };

  const actionColor = onAccent ? "rgba(255,255,255,0.75)" : "var(--muted)";
  const actionBtn: React.CSSProperties = {
    background: "none", border: "none", cursor: "pointer", color: actionColor,
    fontSize: "0.8rem", lineHeight: 1, padding: "0.25rem", minWidth: 28, minHeight: 28,
    display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-sm)",
  };

  const bubble: React.CSSProperties = {
    maxWidth: "88%",
    padding: "0.55rem 0.75rem",
    borderRadius: "0.75rem",
    fontSize: "0.86rem",
    lineHeight: 1.5,
    wordBreak: "break-word",
    ...(!useMarkdown ? { whiteSpace: "pre-wrap" } : {}),
    ...STYLES[role],
  };

  return (
    <div style={bubble}>
      {useMarkdown ? <Markdown text={content} /> : content}
      {showActions && (
        <div className="flex gap-0.5 mt-1" style={{ marginLeft: -4, opacity: 0.85 }}>
          {canSpeak && (
            <button
              type="button"
              onClick={onSpeak}
              title={speaking ? "Stop" : "Speak this message"}
              aria-label={speaking ? "Stop speaking" : "Speak this message"}
              style={{ ...actionBtn, color: speaking ? (onAccent ? "white" : "var(--accent)") : actionColor }}
            >
              <span aria-hidden>{speaking ? "■" : "🔊"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            title="Copy this message"
            aria-label="Copy this message"
            style={{ ...actionBtn, color: copied ? (onAccent ? "white" : "var(--success)") : actionColor }}
          >
            <span aria-hidden>{copied ? "✓" : "⧉"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

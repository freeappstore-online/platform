/** Chat message bubble — user, assistant, tool, or system.
 *  User/assistant bubbles get Speak + Copy actions beneath the content. */

import { useState } from "react";
import { Markdown } from "./Markdown";

const ROLE_CLASSES: Record<string, string> = {
  user: "self-end bg-accent text-white rounded-xl rounded-br-[0.15rem] px-3 py-[0.55rem] text-[0.86rem]",
  assistant: "self-start bg-panel border border-line rounded-xl rounded-bl-[0.15rem] px-3 py-[0.55rem] text-[0.86rem]",
  tool: "self-start bg-panel border border-line text-muted rounded-[0.35rem] px-2 py-1 text-[0.72rem] font-[monospace]",
  system: "self-center text-muted bg-transparent rounded-xl px-3 py-[0.55rem] text-[0.78rem]",
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

  const actionColor = onAccent ? "text-white/75" : "text-muted";
  const actionBtn = "inline-flex min-h-7 min-w-7 cursor-pointer items-center justify-center rounded-control-sm border-none bg-transparent p-1 text-[0.8rem] leading-none";
  const bubble = ROLE_CLASSES[role] ?? "rounded-xl px-3 py-[0.55rem] text-[0.86rem]";

  return (
    <div className={`max-w-[88%] leading-normal [word-break:break-word] ${useMarkdown ? "" : "whitespace-pre-wrap"} ${bubble}`}>
      {useMarkdown ? <Markdown text={content} /> : content}
      {showActions && (
        <div className="flex gap-0.5 mt-1 -ml-1 opacity-85">
          {canSpeak && (
            <button
              type="button"
              onClick={onSpeak}
              title={speaking ? "Stop" : "Speak this message"}
              aria-label={speaking ? "Stop speaking" : "Speak this message"}
              className={`${actionBtn} ${speaking ? (onAccent ? "text-white" : "text-accent") : actionColor}`}
            >
              <span aria-hidden>{speaking ? "■" : "🔊"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            title="Copy this message"
            aria-label="Copy this message"
            className={`${actionBtn} ${copied ? (onAccent ? "text-white" : "text-success") : actionColor}`}
          >
            <span aria-hidden>{copied ? "✓" : "⧉"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

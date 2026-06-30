import { useState } from "react";
import { Link } from "react-router-dom";
import { ProjectPicker } from "../ProjectPicker";
import type { Agent } from "../../hooks/useAgent";
import type { StudioSettings } from "./types";
import { SettingsPanel } from "./SettingsPanel";
import { CopyLogButton } from "./CopyLogButton";

/** Desktop chat toolbar: back · project picker · tokens · copy log · settings · keys. */
export function Toolbar({ agent, settings, settingsOpen, setSettingsOpen, onBackToConsole, onPickProject, onCreateProject }: {
  agent: Agent;
  settings: StudioSettings;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  onBackToConsole: () => void;
  onPickProject: (id: string) => void;
  onCreateProject: (name: string, appId?: string) => void;
}) {
  const iconBtn: React.CSSProperties = { background: "none", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", minWidth: 40, minHeight: 40, padding: "0.25rem 0.5rem", cursor: "pointer", color: "var(--ink)", fontSize: "1rem", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "0.25rem" };
  const textBtn: React.CSSProperties = { ...iconBtn, fontSize: "0.82rem", padding: "0.25rem 0.6rem" };
  const [pickerOpen, setPickerOpen] = useState(false);

  const currentName = agent.projects.find((p) => p.id === agent.currentProjectId)?.name || "Select project";

  return (
    <>
      <div className="flex items-center gap-1 shrink-0" style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)", background: "var(--panel)", fontSize: "0.78rem", overflow: "hidden" }}>
        <button onClick={onBackToConsole} title="Back to My Apps" aria-label="Back to My Apps" style={iconBtn}>
          &#8592;
        </button>
        <button onClick={() => setPickerOpen(true)} className="flex items-center gap-1" style={{ ...textBtn, justifyContent: "flex-start", maxWidth: 200, minWidth: 0, overflow: "hidden" }}>
          <span className="truncate" style={{ minWidth: 0 }}>{currentName}</span>
          <span style={{ fontSize: "0.6rem", flexShrink: 0 }}>▼</span>
        </button>
        <span className="ml-auto" style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          In: <strong>{agent.tokensIn.toLocaleString()}</strong> Out: <strong>{agent.tokensOut.toLocaleString()}</strong>
        </span>
        <div style={{ flexShrink: 0 }}>
          <CopyLogButton agent={agent} provider={settings.provider} model={settings.model} />
        </div>
        <button onClick={() => setSettingsOpen(!settingsOpen)} title="Provider, model & voice" aria-label="Settings" aria-expanded={settingsOpen} style={{ ...iconBtn, flexShrink: 0, background: settingsOpen ? "var(--accent-soft)" : "none", borderColor: settingsOpen ? "var(--accent)" : "var(--line)" }}>&#9881;</button>
        <Link to="/profile" title="Manage API keys in Profile" aria-label="Manage API keys in Profile" style={{ ...iconBtn, flexShrink: 0, textDecoration: "none" }}>
          <span aria-hidden style={{ color: settings.keyStatus.color }}>●</span>
          <span style={{ fontSize: "0.82rem" }}>Keys</span>
        </Link>
      </div>
      {settingsOpen && <SettingsPanel {...settings} />}
      {pickerOpen && (
        <ProjectPicker
          projects={agent.projects}
          currentId={agent.currentProjectId}
          onSelect={(id) => onPickProject(id)}
          onCreate={(name, appId) => onCreateProject(name, appId)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

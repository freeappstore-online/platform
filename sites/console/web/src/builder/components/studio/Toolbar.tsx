import { useState } from "react";
import { Link } from "react-router-dom";
import { ProjectPicker } from "../ProjectPicker";
import type { Agent } from "../../hooks/useAgent";
import type { StudioSettings } from "./types";
import { SettingsPanel } from "./SettingsPanel";
import { CopyLogButton } from "./CopyLogButton";

/** Desktop chat toolbar: back · project picker · tokens · copy log · settings · keys. */
export function Toolbar({ agent, settings, settingsOpen, setSettingsOpen, onBackToConsole, onPickProject, onCreateProject, onOpenApp }: {
  agent: Agent;
  settings: StudioSettings;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  onBackToConsole: () => void;
  onPickProject: (id: string) => void;
  onCreateProject: (name: string) => void;
  onOpenApp: (appId: string) => void;
}) {
  const iconBtn = "inline-flex min-h-10 items-center gap-1 rounded-control-sm border py-1 cursor-pointer text-ink";
  const keyClass = settings.keyStatus.color === "var(--success)" ? "text-success" : "text-warning";
  const [pickerOpen, setPickerOpen] = useState(false);

  const currentName = agent.projects.find((p) => p.id === agent.currentProjectId)?.name || "Select project";

  return (
    <>
      <div className="flex items-center gap-1 shrink-0 py-[0.4rem] px-2 border-b border-line bg-panel text-[0.78rem] overflow-hidden">
        <button onClick={onBackToConsole} title="Back to projects" aria-label="Back to projects" className={`${iconBtn} min-w-10 justify-center px-2 text-base border-line bg-transparent}`}>
          &#8592;
        </button>
        <button onClick={() => setPickerOpen(true)} className={`${iconBtn} justify-start max-w-[200px] min-w-0 overflow-hidden px-[0.6rem] text-[0.82rem] border-line bg-transparent}`}>
          <span className="truncate min-w-0">{currentName}</span>
          <span className="text-[0.6rem] shrink-0">▼</span>
        </button>
        <span className="ml-auto text-muted tabular-nums shrink-0">
          In: <strong>{agent.tokensIn.toLocaleString()}</strong> Out: <strong>{agent.tokensOut.toLocaleString()}</strong>
        </span>
        <div className="shrink-0">
          <CopyLogButton agent={agent} provider={settings.provider} model={settings.model} />
        </div>
        <button onClick={() => setSettingsOpen(!settingsOpen)} title="Provider, model & voice" aria-label="Settings" aria-expanded={settingsOpen} className={`${iconBtn} min-w-10 justify-center px-2 text-base shrink-0 ${settingsOpen ? "bg-(--accent-soft) border-accent" : "bg-transparent border-line"}`}>&#9881;</button>
        <Link to="/profile" title="Manage API keys in Profile" aria-label="Manage API keys in Profile" className={`${iconBtn} min-w-10 justify-center px-2 text-base shrink-0 no-underline border-line bg-transparent}`}>
          <span aria-hidden className={keyClass}>●</span>
          <span className="text-[0.82rem]">Keys</span>
        </Link>
      </div>
      {settingsOpen && <SettingsPanel {...settings} />}
      {pickerOpen && (
        <ProjectPicker
          projects={agent.projects}
          currentId={agent.currentProjectId}
          onSelect={(id) => onPickProject(id)}
          onCreate={onCreateProject}
          onOpenApp={onOpenApp}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

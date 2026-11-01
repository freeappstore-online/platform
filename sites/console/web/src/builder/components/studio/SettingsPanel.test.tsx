import { Toolbar } from "./Toolbar";
import type { Agent } from "../../hooks/useAgent";
﻿import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import type { StudioSettings } from "./types";

const noop = () => {};
const settings: StudioSettings = {
  provider: "openai", model: "", temperature: 0.7,
  setProvider: noop, setModel: noop, setTemperature: noop,
  keyReady: false, keyStatus: { color: "var(--warning)", label: "No key — add one" },
  voiceEnabled: false, voiceSupported: true, setVoiceEnabled: noop,
};

describe("SettingsPanel", () => {
  it.each([false, true])("reflects voice enabled=%s in appearance and accessibility", (voiceEnabled) => {
    const html = renderToStaticMarkup(<MemoryRouter><SettingsPanel {...settings} voiceEnabled={voiceEnabled} /></MemoryRouter>);
    expect(html).toContain('aria-pressed="' + voiceEnabled + '"');
    expect(html).toContain(voiceEnabled ? "bg-(--accent-soft) border-accent text-accent" : "bg-paper border-line text-ink");
    expect(html).toContain('href="/profile"');
    expect(html).toContain("text-warning");
  });
  it("hides unsupported voice controls and the key link when a key is ready", () => {
    const html = renderToStaticMarkup(<MemoryRouter><SettingsPanel {...settings} voiceSupported={false} keyReady keyStatus={{ color: "var(--success)", label: "Key in vault" }} /></MemoryRouter>);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain('href="/profile"');
    expect(html).toContain("text-success");
    expect(html).toContain("Key in vault");
  });
});

describe("Toolbar", () => {
  it.each([false, true])("reflects settings open=%s and the key status", (settingsOpen) => {
    const agent = { projects: [], tokensIn: 10, tokensOut: 20 } as unknown as Agent;
    const html = renderToStaticMarkup(<MemoryRouter><Toolbar agent={agent} settings={settings}
      settingsOpen={settingsOpen} setSettingsOpen={noop} onBackToConsole={noop}
      onPickProject={noop} onCreateProject={noop} /></MemoryRouter>);
    expect(html).toContain('aria-expanded="' + settingsOpen + '"');
    expect(html).toContain(settingsOpen ? "bg-(--accent-soft) border-accent" : "bg-transparent border-line");
    expect(html).toContain("Select project");
    expect(html).toContain("text-warning");
    expect(html.includes("Temp 0.3")).toBe(settingsOpen);
  });
});

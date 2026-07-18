import { Link } from "react-router-dom";
import { PROVIDERS, MODEL_OPTIONS } from "../../lib/ai-keys";
import type { StudioSettings } from "./types";

/** Shared provider/model/voice/key settings — used by desktop Toolbar + mobile bar. */
export function SettingsPanel({
  provider, setProvider, model, setModel, temperature, setTemperature,
  keyReady, keyStatus, voiceEnabled, voiceSupported, setVoiceEnabled,
}: StudioSettings) {
  const sel: React.CSSProperties = { minHeight: 38, padding: "0.35rem 0.5rem", border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", background: "var(--paper)", color: "var(--ink)", fontFamily: "inherit", fontSize: "0.85rem" };
  return (
    <div className="flex flex-wrap items-center gap-2" style={{ padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--line)", background: "var(--panel)" }}>
      <select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(MODEL_OPTIONS[e.target.value]?.[0]?.value || ""); }} style={sel}>
        {PROVIDERS.map((p) => (
          <option key={p.type} value={p.type}>{p.name}{p.free ? " (free)" : ""}</option>
        ))}
      </select>
      <select value={model} onChange={(e) => setModel(e.target.value)} style={sel}>
        {(MODEL_OPTIONS[provider] || []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      <select value={temperature} onChange={(e) => setTemperature(parseFloat(e.target.value))} style={sel}>
        <option value={0}>Temp 0</option><option value={0.3}>Temp 0.3</option><option value={0.7}>Temp 0.7</option><option value={1}>Temp 1</option>
      </select>
      {voiceSupported && (
        <button
          onClick={() => setVoiceEnabled(!voiceEnabled)}
          aria-pressed={voiceEnabled}
          style={{ ...sel, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "0.35rem", background: voiceEnabled ? "var(--accent-soft)" : "var(--paper)", borderColor: voiceEnabled ? "var(--accent)" : "var(--line)", color: voiceEnabled ? "var(--accent)" : "var(--ink)" }}
        >
          <span aria-hidden>{voiceEnabled ? "🔊" : "🔇"}</span> Voice {voiceEnabled ? "on" : "off"}
        </button>
      )}
      <span className="text-xs" style={{ color: keyStatus.color, marginLeft: "auto" }}>{keyStatus.label}</span>
      {!keyReady && (
        <Link to="/profile" className="text-xs font-semibold" style={{ color: "var(--accent)", textDecoration: "none" }}>
          Add key →
        </Link>
      )}
    </div>
  );
}

import { Link } from "react-router-dom";
import { PROVIDERS, MODEL_OPTIONS } from "../../lib/ai-keys";
import type { StudioSettings } from "./types";

/** Shared provider/model/voice/key settings — used by desktop Toolbar + mobile bar. */
export function SettingsPanel({
  provider, setProvider, model, setModel, temperature, setTemperature,
  keyReady, keyStatus, voiceEnabled, voiceSupported, setVoiceEnabled,
}: StudioSettings) {
  const sel = "min-h-[38px] py-[0.35rem] px-2 border rounded-control-sm font-[inherit] text-[0.85rem]";
  const keyClass = keyStatus.color === "var(--success)" ? "text-success" : "text-warning";
  return (
    <div className="flex flex-wrap items-center gap-2 py-[0.6rem] px-3 border-b border-line bg-panel">
      <select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(MODEL_OPTIONS[e.target.value]?.[0]?.value || ""); }} className={`${sel} border-line bg-paper text-ink}`}>
        {PROVIDERS.map((p) => (
          <option key={p.type} value={p.type}>{p.name}{p.free ? " (free)" : ""}</option>
        ))}
      </select>
      <select value={model} onChange={(e) => setModel(e.target.value)} className={`${sel} border-line bg-paper text-ink}`}>
        {(MODEL_OPTIONS[provider] || []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      <select value={temperature} onChange={(e) => setTemperature(parseFloat(e.target.value))} className={`${sel} border-line bg-paper text-ink}`}>
        <option value={0}>Temp 0</option><option value={0.3}>Temp 0.3</option><option value={0.7}>Temp 0.7</option><option value={1}>Temp 1</option>
      </select>
      {voiceSupported && (
        <button
          onClick={() => setVoiceEnabled(!voiceEnabled)}
          aria-pressed={voiceEnabled}
          className={`${sel} cursor-pointer inline-flex items-center gap-[0.35rem] ${voiceEnabled ? "bg-(--accent-soft) border-accent text-accent" : "bg-paper border-line text-ink"}`}
        >
          <span aria-hidden>{voiceEnabled ? "🔊" : "🔇"}</span> Voice {voiceEnabled ? "on" : "off"}
        </button>
      )}
      <span className={`text-xs ml-auto ${keyClass}`}>{keyStatus.label}</span>
      {!keyReady && (
        <Link to="/profile" className="text-xs font-semibold text-accent no-underline">
          Add key →
        </Link>
      )}
    </div>
  );
}

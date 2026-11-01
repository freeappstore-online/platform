import { useState, useEffect, useCallback } from "react";
import { Nav } from "../components/Nav";
import { AISettings } from "../components/AISettings";
import { useAuth } from "../hooks/useAuth";
import { useSpeech } from "../hooks/useSpeech";
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from "../lib/push";
import { PROVIDERS, getDefaultProvider, getDefaultModel, fetchVaultUsage, type VaultUsage } from "../lib/ai-keys";
import { useTheme } from "../lib/theme";
import { useTextSize } from "../lib/text-size";

const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  openrouter: [
    { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
    { value: "anthropic/claude-opus-4", label: "Claude Opus 4" },
    { value: "openai/gpt-4.1", label: "GPT-4.1" },
    { value: "openai/gpt-4o", label: "GPT-4o" },
    { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek V3" },
  ],
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  ],
  google: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
};

function useNotificationState() {
  const [supported] = useState(() => "Notification" in window && "serviceWorker" in navigator && "PushManager" in window);
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  useEffect(() => {
    if (!supported) return;
    if (typeof Notification !== "undefined") setPermission(Notification.permission);
    navigator.serviceWorker.ready.then((reg) =>
      reg.pushManager.getSubscription().then((sub) => setSubscribed(!!sub)),
    );
  }, [supported]);

  const enabled = permission === "granted" && subscribed;

  const toggle = useCallback(async () => {
    if (!supported) return;
    if (enabled) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      setSubscribed(false);
    } else {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === "granted") {
        const reg = await navigator.serviceWorker.ready;
        await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        setSubscribed(true);
      }
    }
  }, [enabled, supported]);

  return { enabled, permission, supported, toggle };
}

export function Profile() {
  const { user, loading, signIn, signOut } = useAuth();
  const notif = useNotificationState();
  const speech = useSpeech();
  const { pref: themePref, set: setThemePref } = useTheme();
  const { size: textSize, setSize: setTextSize } = useTextSize();
  const [provider, setProvider] = useState(getDefaultProvider);
  const [model, setModel] = useState(() => {
    const p = getDefaultProvider();
    const stored = getDefaultModel();
    return MODEL_OPTIONS[p]?.some((m) => m.value === stored)
      ? stored
      : MODEL_OPTIONS[p]?.[0]?.value || "claude-sonnet-4-6";
  });
  const [usage, setUsage] = useState<VaultUsage | null>(null);

  useEffect(() => { localStorage.setItem("fas_provider", provider); }, [provider]);
  useEffect(() => { localStorage.setItem("fas_model", model); }, [model]);
  useEffect(() => { fetchVaultUsage().then(setUsage); }, []);

  if (loading) {
    return (<><Nav /><div className="container py-16 text-center text-muted">Loading...</div></>);
  }

  if (!user) {
    return (
      <><Nav /><div className="container py-16 text-center">
        <p className="mb-4 text-muted">
          Sign in to manage your settings.
        </p>
        <button
          onClick={signIn}
          className="px-5 py-2 rounded-xl text-sm font-semibold border bg-transparent text-ink border-line cursor-pointer font-[inherit]"
        >
          Sign in with GitHub
        </button>
      </div></>
    );
  }

  return (
    <>
    <Nav />
    <div className="container py-8 max-w-[640px]">
      {/* Avatar + name card */}
      <div
        className="flex items-center gap-5 p-5 rounded-2xl border mb-6 bg-panel border-line shadow-[var(--shadow)]"
      >
        {user.avatarUrl && (
          <img
            src={user.avatarUrl}
            alt={user.login}
            className="rounded-full border-2 shrink-0 w-[56px] h-[56px] border-line"
          />
        )}
        <div className="flex-1 min-w-0">
          <h2 className="font-display text-xl font-extrabold truncate text-ink-strong">{user.login}</h2>
          <p className="text-xs text-muted">
            Signed in via GitHub
          </p>
          <p className="text-xs font-mono mt-1 select-all text-muted">
            {user.id}
          </p>
        </div>
      </div>

      {/* Appearance */}
      <Section title="Appearance">
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-xs font-semibold block mb-2 text-muted">Theme</label>
            <div className="flex gap-2 flex-wrap">
              {(["system", "light", "dark"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setThemePref(t)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-semibold border capitalize ${(themePref === t ? "bg-accent" : "bg-transparent")} ${(themePref === t ? "text-white" : "text-muted")} ${(themePref === t ? "border-accent" : "border-line")} cursor-pointer font-[inherit]`}

                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-2 text-muted">Text Size</label>
            <div className="flex gap-2 flex-wrap">
              {([["sm", "Small"], ["default", "Default"], ["lg", "Large"]] as const).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setTextSize(val)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-semibold border ${(textSize === val ? "bg-accent" : "bg-transparent")} ${(textSize === val ? "text-white" : "text-muted")} ${(textSize === val ? "border-accent" : "border-line")} cursor-pointer font-[inherit]`}

                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Default AI preferences */}
      <Section title="Default AI Settings">
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Provider</label>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                const models = MODEL_OPTIONS[e.target.value];
                if (models?.length) setModel(models[0].value);
              }}
              className="w-full p-2.5 rounded-lg border text-sm bg-paper border-line text-ink"
            >
              {PROVIDERS.map((p) => (
                <option key={p.type} value={p.type}>{p.name}{p.free ? " (free)" : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full p-2.5 rounded-lg border text-sm bg-paper border-line text-ink"
            >
              {(MODEL_OPTIONS[provider] || []).map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>
      </Section>

      {/* AI Provider Keys — vault-backed */}
      <Section title="API Keys (Platform Vault)">
        <AISettings />
      </Section>

      {/* Usage */}
      {usage && (
        <Section title="Daily Usage">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm">API proxy calls today</span>
            <span className={`text-sm font-semibold ${(usage.used >= usage.limit ? "text-danger" : "text-ink")}`} >
              {usage.used.toLocaleString()} / {usage.limit.toLocaleString()}
            </span>
          </div>
          <div className="w-full rounded-full overflow-hidden h-[6px] bg-line">
            <svg className="w-full h-full" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect width={Math.min((usage.used / usage.limit) * 100, 100)} height="6" rx="3" className={usage.used >= usage.limit * 0.9 ? "fill-danger" : "fill-accent"} /></svg>
          </div>
          <p className="text-xs mt-2 text-muted">
            Resets daily at midnight UTC. This caps how many API calls apps can make using your keys through the platform proxy.
          </p>
        </Section>
      )}

      {/* Voice */}
      {speech.supported && (
        <Section title="Voice">
          <div className="flex justify-between items-center mb-3">
            <div>
              <span className="text-sm font-medium">Tap-to-speak</span>
              <p className="text-xs mt-0.5 text-muted">
                Tap any chat message to hear it read aloud
              </p>
            </div>
            <Toggle on={speech.enabled} onToggle={() => speech.setEnabled(!speech.enabled)} />
          </div>
          <div className="flex justify-between items-center mb-3">
            <div>
              <span className="text-sm font-medium">Auto-speak replies</span>
              <p className="text-xs mt-0.5 text-muted">
                Read each assistant reply automatically when it finishes
              </p>
            </div>
            <Toggle on={speech.autoSpeak} onToggle={() => speech.setAutoSpeak(!speech.autoSpeak)} disabled={!speech.enabled} />
          </div>
          {speech.voices.length > 0 && (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Voice</label>
              <select
                value={speech.voiceURI ?? ""}
                onChange={(e) => speech.setVoiceURI(e.target.value || null)}
                className="w-full p-2.5 rounded-lg border text-sm bg-paper border-line text-ink"
              >
                <option value="">System default</option>
                {speech.voices
                  .filter((v) => v.lang.startsWith("en"))
                  .map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
                  ))}
              </select>
              <button
                onClick={() => speech.speak("preview", "Hi! This is how I'll read your messages.")}
                disabled={!speech.enabled}
                className={`mt-2 text-xs font-semibold ${(speech.enabled ? "text-accent" : "text-muted")} bg-transparent border-0 ${(speech.enabled ? "cursor-pointer" : "[cursor:default]")}`}

              >
                ▶ Preview voice
              </button>
            </div>
          )}
        </Section>
      )}

      {/* Notifications */}
      {notif.supported && (
        <Section title="Notifications">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-sm font-medium">Push notifications</span>
              <p className="text-xs mt-0.5 text-muted">
                Get notified when your build finishes
              </p>
            </div>
            <button
              onClick={notif.toggle}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${(notif.enabled ? "bg-accent" : "bg-(--line-strong)")} border-0 ${(notif.permission === "denied" ? "[cursor:not-allowed]" : "cursor-pointer")} ${(notif.permission === "denied" ? "opacity-[0.5]" : "opacity-[1]")}`}

              disabled={notif.permission === "denied"}
              title={notif.permission === "denied" ? "Notifications blocked in browser settings" : undefined}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform bg-white ${(notif.enabled ? "left-[22px]" : "left-0.5")}`}

              />
            </button>
          </div>
          {notif.permission === "denied" && (
            <p className="text-xs mt-2 text-warning">
              Notifications are blocked. Enable them in your browser settings for this site.
            </p>
          )}
        </Section>
      )}

      {/* Sign out — small, at bottom */}
      <div className="mt-6 pt-4 text-center border-t border-line">
        <button
          onClick={signOut}
          className="text-sm bg-transparent border-0 text-muted cursor-pointer font-[inherit]"
        >
          Sign out
        </button>
      </div>
    </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h3
        className="text-sm font-bold uppercase mb-3 pb-2 border-b tracking-wide border-line text-muted"
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function Toggle({ on, onToggle, disabled }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${(on ? "bg-accent" : "bg-(--line-strong)")} border-0 ${(disabled ? "[cursor:not-allowed]" : "cursor-pointer")} ${(disabled ? "opacity-[0.5]" : "opacity-[1]")}`}

      aria-pressed={on}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full transition-transform bg-white ${(on ? "left-[22px]" : "left-0.5")}`}

      />
    </button>
  );
}

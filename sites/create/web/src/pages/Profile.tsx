import { useState, useEffect, useCallback } from "react";
import { Nav } from "../components/Nav";
import { AISettings } from "../components/AISettings";
import { useAuth } from "../hooks/useAuth";
import { useSpeech } from "../hooks/useSpeech";
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from "../lib/push";
import { PROVIDERS, getDefaultProvider, getDefaultModel, fetchVaultUsage, type VaultUsage } from "../lib/ai-keys";

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
  const [provider, setProvider] = useState(getDefaultProvider);
  const [model, setModel] = useState(getDefaultModel);
  const [usage, setUsage] = useState<VaultUsage | null>(null);

  useEffect(() => { localStorage.setItem("fas_provider", provider); }, [provider]);
  useEffect(() => { localStorage.setItem("fas_model", model); }, [model]);
  useEffect(() => { fetchVaultUsage().then(setUsage); }, []);

  if (loading) {
    return (<><Nav /><div className="container py-16 text-center" style={{ color: "var(--muted)" }}>Loading...</div></>);
  }

  if (!user) {
    return (
      <><Nav /><div className="container py-16 text-center">
        <p className="mb-4" style={{ color: "var(--muted)" }}>
          Sign in to manage your settings.
        </p>
        <button
          onClick={signIn}
          className="px-5 py-2 rounded-xl text-sm font-semibold border"
          style={{
            background: "transparent",
            color: "var(--ink)",
            borderColor: "var(--line)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Sign in with GitHub
        </button>
      </div></>
    );
  }

  return (
    <>
    <Nav />
    <div className="container py-8" style={{ maxWidth: 640 }}>
      {/* Avatar + name card */}
      <div
        className="flex items-center gap-5 p-5 rounded-2xl border mb-6"
        style={{ background: "var(--panel)", borderColor: "var(--line)", boxShadow: "var(--shadow)" }}
      >
        {user.avatarUrl && (
          <img
            src={user.avatarUrl}
            alt={user.login}
            className="rounded-full border-2 shrink-0"
            style={{ width: 56, height: 56, borderColor: "var(--line)" }}
          />
        )}
        <div className="flex-1 min-w-0">
          <h2 className="font-display text-xl font-extrabold truncate" style={{ color: "var(--ink-strong)" }}>{user.login}</h2>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Signed in via GitHub
          </p>
          <p className="text-xs font-mono mt-1 select-all" style={{ color: "var(--muted)" }}>
            {user.id}
          </p>
        </div>
      </div>

      {/* Default AI preferences */}
      <Section title="Default AI Settings">
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: "var(--muted)" }}>Provider</label>
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                const models = MODEL_OPTIONS[e.target.value];
                if (models?.length) setModel(models[0].value);
              }}
              className="w-full p-2.5 rounded-lg border text-sm"
              style={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)" }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.type} value={p.type}>{p.name}{p.free ? " (free)" : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: "var(--muted)" }}>Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full p-2.5 rounded-lg border text-sm"
              style={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)" }}
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
            <span className="text-sm font-semibold" style={{ color: usage.used >= usage.limit ? "var(--error)" : "var(--ink)" }}>
              {usage.used.toLocaleString()} / {usage.limit.toLocaleString()}
            </span>
          </div>
          <div className="w-full rounded-full overflow-hidden" style={{ height: 6, background: "var(--line)" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min((usage.used / usage.limit) * 100, 100)}%`,
                background: usage.used >= usage.limit * 0.9 ? "var(--error)" : "var(--accent)",
              }}
            />
          </div>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
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
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Tap any chat message to hear it read aloud
              </p>
            </div>
            <Toggle on={speech.enabled} onToggle={() => speech.setEnabled(!speech.enabled)} />
          </div>
          <div className="flex justify-between items-center mb-3">
            <div>
              <span className="text-sm font-medium">Auto-speak replies</span>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Read each assistant reply automatically when it finishes
              </p>
            </div>
            <Toggle on={speech.autoSpeak} onToggle={() => speech.setAutoSpeak(!speech.autoSpeak)} disabled={!speech.enabled} />
          </div>
          {speech.voices.length > 0 && (
            <div>
              <label className="text-xs font-semibold block mb-1" style={{ color: "var(--muted)" }}>Voice</label>
              <select
                value={speech.voiceURI ?? ""}
                onChange={(e) => speech.setVoiceURI(e.target.value || null)}
                className="w-full p-2.5 rounded-lg border text-sm"
                style={{ background: "var(--paper)", borderColor: "var(--line)", color: "var(--ink)" }}
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
                className="mt-2 text-xs font-semibold"
                style={{ color: speech.enabled ? "var(--accent)" : "var(--muted)", background: "none", border: "none", cursor: speech.enabled ? "pointer" : "default" }}
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
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Get notified when your build finishes
              </p>
            </div>
            <button
              onClick={notif.toggle}
              className="relative w-11 h-6 rounded-full transition-colors shrink-0"
              style={{
                background: notif.enabled ? "var(--accent)" : "var(--line-strong)",
                border: "none",
                cursor: notif.permission === "denied" ? "not-allowed" : "pointer",
                opacity: notif.permission === "denied" ? 0.5 : 1,
              }}
              disabled={notif.permission === "denied"}
              title={notif.permission === "denied" ? "Notifications blocked in browser settings" : undefined}
            >
              <span
                className="absolute top-0.5 w-5 h-5 rounded-full transition-transform"
                style={{
                  background: "white",
                  left: notif.enabled ? 22 : 2,
                }}
              />
            </button>
          </div>
          {notif.permission === "denied" && (
            <p className="text-xs mt-2" style={{ color: "var(--warning)" }}>
              Notifications are blocked. Enable them in your browser settings for this site.
            </p>
          )}
        </Section>
      )}

      {/* Sign out — small, at bottom */}
      <div className="mt-6 pt-4 text-center" style={{ borderTop: "1px solid var(--line)" }}>
        <button
          onClick={signOut}
          className="text-sm"
          style={{
            background: "none",
            border: "none",
            color: "var(--muted)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
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
        className="text-sm font-bold uppercase mb-3 pb-2 border-b tracking-wide"
        style={{ borderColor: "var(--line)", color: "var(--muted)" }}
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
      className="relative w-11 h-6 rounded-full transition-colors shrink-0"
      style={{
        background: on ? "var(--accent)" : "var(--line-strong)",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
      aria-pressed={on}
    >
      <span
        className="absolute top-0.5 w-5 h-5 rounded-full transition-transform"
        style={{ background: "white", left: on ? 22 : 2 }}
      />
    </button>
  );
}

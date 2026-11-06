import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Nav } from "../components/Nav";
import { ChatMessage } from "../components/ChatMessage";
import { DeployLog } from "../components/DeployLog";
import { MyAppsConsole } from "../components/MyAppsConsole";
import { Segmented } from "../components/studio/Segmented";
import { SettingsPanel } from "../components/studio/SettingsPanel";
import { Toolbar } from "../components/studio/Toolbar";
import { CopyLogButton } from "../components/studio/CopyLogButton";
import { PublishModal } from "../components/studio/PublishModal";
import { DeployStatusBar } from "../components/studio/DeployStatusBar";
import type { StudioSettings } from "../components/studio/types";
import { useAuth } from "../hooks/useAuth";
import { useAgent, type AIConfig } from "../hooks/useAgent";
import { useSpeech } from "../hooks/useSpeech";
import { PROVIDERS, MODEL_OPTIONS, fetchVaultStatus, getKey, getDefaultProvider, toVaultProvider, fromVaultProvider, type VaultKeyStatus } from "../lib/ai-keys";

export function Create() {
  const { user, loading, signIn } = useAuth();
  const agent = useAgent();
  const speech = useSpeech();
  const navigate = useNavigate();
  const { id: routeId } = useParams();
  const [searchParams] = useSearchParams();
  const openAppId = searchParams.get("app");
  const [openError, setOpenError] = useState<string | null>(null);
  const openingRef = useRef<string | null>(null);
  // The URL is the source of truth for which view: /app/:id → that app's chat,
  // bare / → the My Apps console. Pinning /app/:id to the home screen opens
  // straight into one app (iOS captures the current URL on Add to Home Screen).
  const view: "console" | "chat" = routeId ? "chat" : "console";
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // getDefaultProvider drops a stale provider (e.g. legacy "github") that's no
  // longer offered. Ensure the stored model is valid for the chosen provider.
  const [provider, setProvider] = useState(getDefaultProvider);
  const [model, setModel] = useState(() => {
    const p = getDefaultProvider();
    const stored = localStorage.getItem("fas_model");
    const valid = MODEL_OPTIONS[p]?.some((m) => m.value === stored);
    return valid ? stored! : MODEL_OPTIONS[p]?.[0]?.value || "claude-sonnet-4-6";
  });
  const [temperature, setTemperature] = useState(0.7);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vaultKeys, setVaultKeys] = useState<VaultKeyStatus[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [visibleCount, setVisibleCount] = useState(10);
  const [mobileTab, setMobileTab] = useState<"chat" | "preview">("chat");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishResult, setPublishResult] = useState<{ url: string; audit: any } | null>(null);
  const wasStreamingRef = useRef(false);

  // Sync the URL's app id into the selected project.
  useEffect(() => {
    if (routeId && routeId !== agent.currentProjectId) agent.switchProject(routeId);
  }, [routeId]);

  // Auto-speak: when a turn finishes (streaming true→false) and auto-speak is
  // on, read the latest assistant message aloud.
  useEffect(() => {
    if (wasStreamingRef.current && !agent.isStreaming && speech.enabled && speech.autoSpeak) {
      const msgs = agent.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant" && msgs[i].content.trim()) {
          speech.speak(`msg-${i}`, msgs[i].content);
          break;
        }
      }
    }
    wasStreamingRef.current = agent.isStreaming;
  }, [agent.isStreaming, agent.messages, speech]);

  // Refetch vault status whenever the signed-in user changes (including on
  // post-OAuth-redirect transitions, where the token arrives after Create
  // already mounted). Without [user?.id] this only ran once with no token.
  useEffect(() => {
    if (!user) { setVaultKeys([]); return; }
    fetchVaultStatus().then(setVaultKeys);
  }, [user?.id]);
  useEffect(() => { speech.cancel(); }, [agent.currentProjectId]);

  const vaultMap = new Map(vaultKeys.map((k) => [k.provider, k]));
  const providerCfg = PROVIDERS.find((p) => p.type === provider);
  const hasVaultKey = vaultMap.has(toVaultProvider(provider));
  const isFreeProvider = !!providerCfg?.free;
  const keyReady = isFreeProvider || hasVaultKey || !!getKey(provider);

  useEffect(() => {
    if (!user || keyReady || vaultKeys.length === 0) return;
    const nextProvider = vaultKeys
      .map((k) => fromVaultProvider(k.provider))
      .find((p) => MODEL_OPTIONS[p]?.length);
    if (!nextProvider || nextProvider === provider) return;
    setProvider(nextProvider);
    setModel(MODEL_OPTIONS[nextProvider][0]?.value || "");
  }, [user?.id, keyReady, vaultKeys, provider]);

  const keyStatus = isFreeProvider
    ? { color: "var(--success)", label: "Free · no key needed" }
    : hasVaultKey
    ? { color: "var(--success)", label: "Key in vault" }
    : { color: "var(--warning)", label: "No key — add one" };
  const settings: StudioSettings = {
    provider, setProvider, model, setModel, temperature, setTemperature,
    keyReady, keyStatus,
    voiceEnabled: speech.enabled, voiceSupported: speech.supported, setVoiceEnabled: speech.setEnabled,
  };
  useEffect(() => {
    const behavior = agent.messages.length <= 1 ? "instant" : "smooth";
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: behavior as ScrollBehavior }), 50);
  }, [agent.messages]);
  // On app switch / after history loads, jump straight to the latest message.
  useEffect(() => {
    if (agent.isLoadingHistory) return;
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior }), 60);
  }, [agent.currentProjectId, agent.isLoadingHistory]);
  // Show only the last 10 messages per app; "Load older" reveals 10 more.
  useEffect(() => { setVisibleCount(10); }, [agent.currentProjectId]);
  useEffect(() => { localStorage.setItem("fas_provider", provider); }, [provider]);
  useEffect(() => { localStorage.setItem("fas_model", model); }, [model]);

  // ?app=<id> (from "Open in VibeCode"): open that existing app, importing its
  // repo unless a project is already bound to it (#12). Waits for the project
  // list so an existing binding is found rather than duplicated.
  useEffect(() => {
    if (!user || !openAppId || agent.projectsLoading || openingRef.current === openAppId) return;
    openingRef.current = openAppId;
    setOpenError(null);
    agent
      .openApp(openAppId)
      .then((id) => navigate(`/app/${id}`, { replace: true }))
      .catch((err: unknown) => {
        setOpenError(`Couldn't open ${openAppId}: ${err instanceof Error ? err.message : String(err)}`);
        navigate("/", { replace: true });
      });
  }, [user?.id, openAppId, agent.projectsLoading]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[100dvh]">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 rounded-full animate-spin mb-3 border-line border-t-accent"  />
          <p className="text-sm text-muted">Loading...</p>
        </div>
      </div>
    );
  }

  const handleSend = async () => {
    const msg = inputValue.trim();
    if (!msg) return;
    // Send any local key we still have (legacy fallback). If empty, the agent
    // worker resolves the key from the platform vault server-side using the
    // user's auth token — so keys never need to be retyped after Profile setup.
    const key = getKey(provider);
    setInputValue("");
    await agent.sendMessage(msg, { provider, model, apiKey: key, temperature, maxTokens: 16384 } as AIConfig);
  };

  const currentProject = agent.projects.find((p: any) => p.id === agent.currentProjectId);
  const appId = currentProject?.appId;
  const previewUrl = currentProject?.appUrl
    || (appId ? `https://${appId}.freeappstore.online` : null);
  const showPreview = !!previewUrl;

  if (!user) {
    return (
      <>
        <Nav />
        <main className="flex flex-col items-center justify-center text-center min-h-[60vh] p-[4rem_1.5rem] max-w-[640px] m-[0_auto]">
          <h1 className="font-display text-5xl font-extrabold tracking-tight mb-3 text-ink-strong">VibeCode</h1>
          <p className="text-lg mb-8 text-muted max-w-[480px]">
            Describe the app you want. An AI agent builds it, deploys it, and you get a live app on FreeAppStore — in minutes.
          </p>
          <button onClick={signIn} className="inline-flex items-center gap-2 px-6 py-3 rounded-full font-semibold text-white bg-accent">
            Sign in with GitHub to start
          </button>
          <p className="text-sm mt-3 text-muted">Sign in, add your AI provider key, and start building.</p>
        </main>
      </>
    );
  }

  // Console view — My Apps with search
  if (view === "console") {
    return (
      <div className="flex flex-col h-[100dvh] overflow-hidden">
        <div className="shrink-0"><Nav /></div>
        {(openAppId || openError) && (
          <p role="status" className={`shrink-0 text-sm px-4 py-2 ${(openError ? "text-danger" : "text-muted")} [border-bottom:1px_solid_var(--line)]`} >
            {openError ?? `Opening ${openAppId}…`}
          </p>
        )}
        <MyAppsConsole
          projects={agent.projects}
          loading={agent.projectsLoading}
          error={agent.projectsError}
          onRetry={agent.reloadProjects}
          currentId={agent.currentProjectId}
          onSelect={(id) => navigate(`/app/${id}`)}
          onNewChat={() => { const id = agent.createProject("New App"); navigate(`/app/${id}`); }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      {/* Desktop nav */}
      <div className="hidden md:block shrink-0"><Nav /></div>

      {/* Mobile studio bar — single bar: back to apps · Code/Preview switch · settings */}
      <div className="flex md:hidden shrink-0 items-center gap-2 p-[0.4rem_0.5rem] border-b border-line bg-panel">
        <button onClick={() => navigate("/")} title="Back to My Apps" aria-label="Back to My Apps" className="w-[40px] h-[40px] shrink-0 bg-transparent border border-line rounded-control-sm cursor-pointer text-ink text-[1.1rem] inline-flex items-center justify-center">
          &#8592;
        </button>
        <Segmented
          value={mobileTab}
          onChange={setMobileTab}
          options={[{ value: "chat", label: "Code" }, { value: "preview", label: previewUrl ? "Preview ●" : "Preview" }]}
        />
        <div className="shrink-0"><CopyLogButton agent={agent} provider={provider} model={model} /></div>
        <button onClick={() => setSettingsOpen(!settingsOpen)} title="Settings" aria-label="Settings" aria-expanded={settingsOpen} className={`w-10 h-10 shrink-0 border rounded-control-sm cursor-pointer text-[1.05rem] inline-flex items-center justify-center ${settingsOpen ? "bg-(--accent-soft) border-accent text-accent" : "bg-transparent border-line text-ink"}`}>
          &#9881;
        </button>
      </div>
      {/* Mobile settings (shared panel) */}
      <div className="md:hidden shrink-0">{settingsOpen && <SettingsPanel {...settings} />}</div>

      <div className="grid flex-1 min-h-0 grid-cols-1 md:grid-cols-2">
        {/* Chat */}
        <div className={`${`flex flex-col overflow-hidden border-r ${mobileTab !== "chat" ? "hidden md:flex" : ""}`} border-line`} >
          {/* Desktop toolbar (mobile uses the studio bar above) */}
          <div className="hidden md:block">
            <Toolbar
              agent={agent}
              settings={settings}
              settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen}
              onBackToConsole={() => navigate("/")}
              onPickProject={(id: string) => navigate(`/app/${id}`)}
              onCreateProject={(name: string, appId?: string) => { const id = agent.createProject(name, appId); navigate(`/app/${id}`); }}
            />
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-0">
            <div className="flex-1" />
            {agent.historyError && agent.messages.length <= 1 ? (
              <div className="self-center text-center py-8">
                <p className="text-sm font-semibold mb-1">Couldn't load this conversation</p>
                <p className="text-xs mb-3 text-muted">Connection issue — your history is safe on the server.</p>
                <button onClick={() => agent.retryHistory()} className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white bg-accent border-0 cursor-pointer">
                  Retry
                </button>
              </div>
            ) : agent.isLoadingHistory && agent.messages.length <= 1 ? (
              <div className="self-center text-center py-8">
                <div className="inline-block w-5 h-5 border-2 rounded-full animate-spin mb-2 border-line border-t-accent"  />
                <p className="text-xs text-muted">Loading conversation…</p>
              </div>
            ) : (
              (() => {
                const total = agent.messages.length;
                const start = Math.max(0, total - visibleCount);
                return (
                  <>
                    {start > 0 && (
                      <button
                        onClick={() => setVisibleCount((c) => c + 10)}
                        className="self-center text-xs font-semibold mb-1 px-3 py-1.5 rounded-full bg-panel border border-line text-muted cursor-pointer"
                      >
                        Load {Math.min(10, start)} older {start === 1 ? "message" : "messages"}
                      </button>
                    )}
                    {agent.messages.slice(start).map((m, i) => {
                      const id = `msg-${start + i}`;
                      return (
                        <ChatMessage
                          key={id}
                          role={m.role}
                          content={m.content}
                          canSpeak={speech.supported}
                          speaking={speech.speakingId === id}
                          onSpeak={() => speech.speak(id, m.content)}
                        />
                      );
                    })}
                  </>
                );
              })()
            )}
            <div ref={messagesEndRef} />
          </div>
          {agent.queuedMessages.length > 0 && (
            <section className="shrink-0 p-[0.5rem_0.75rem] border-t border-line bg-panel" aria-label="Queued messages" >
              <p className="text-xs font-semibold mb-2 text-muted">
                {agent.queuedMessages.length} queued {agent.queuedMessages.length === 1 ? "message" : "messages"} · sends when the current response finishes
              </p>
              <div className="flex flex-col gap-2 max-h-[180px] [overflow-y:auto]">
                {agent.queuedMessages.map((message, index) => (
                  <div key={message.id} className="flex gap-2 items-start p-[0.45rem] border border-line rounded-control-sm bg-paper">
                    <span className="text-xs font-semibold shrink-0 text-muted pt-[0.45rem]" aria-hidden >{index + 1}</span>
                    <textarea
                      value={message.content}
                      onChange={(e) => agent.editQueuedMessage(message.id, e.target.value)}
                      aria-label={`Queued message ${index + 1}`}
                      rows={2}
                      className="flex-1 resize-y min-w-0 border border-line rounded-[0.35rem] p-[0.35rem_0.45rem] bg-panel text-ink font-[inherit] text-[0.875rem]"
                    />
                    <button
                      type="button"
                      onClick={() => agent.deleteQueuedMessage(message.id)}
                      aria-label={`Remove queued message ${index + 1}`}
                      title="Remove from queue"
                      className="text-xs font-semibold shrink-0 p-[0.45rem] bg-transparent border-0 text-danger cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className="flex gap-2 shrink-0 p-[0.5rem_0.75rem] border-t border-line bg-panel">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder="Build me a meditation timer..."
              rows={1}
              className="flex-1 resize-none border border-line rounded-[0.5rem] p-[0.55rem_0.7rem] bg-paper text-ink text-[1rem] min-h-[44px] max-h-[120px] font-[inherit]"
            />
            <button onClick={handleSend} className="self-end inline-flex items-center justify-center min-h-[44px] min-w-[44px] p-[0.55rem_0.9rem] bg-accent text-white border-0 rounded-control-sm font-[600] text-[1.1rem] cursor-pointer" title={agent.isStreaming ? "Add to queue" : "Send"} aria-label={agent.isStreaming ? "Add to queue" : "Send"} >
              <span aria-hidden>↑</span>
            </button>
          </div>
        </div>
        {/* Preview */}
        <div className={`flex flex-col overflow-hidden ${mobileTab !== "preview" ? "hidden md:flex" : ""}`}>
          <div className="flex items-center gap-2 shrink-0 p-[0.35rem_0.75rem] border-b border-line bg-panel text-[0.78rem]">
            {previewUrl ? (
              <>
                {/* The URL is the open affordance — opens in a new tab. No separate "Open" button. */}
                <a href={previewUrl} target="_blank" rel="noopener" className="text-xs truncate text-accent font-[monospace] min-w-0 flex-1">
                  {previewUrl.replace("https://", "")} ↗
                </a>
                {appId && (
                  <button onClick={() => navigate(`/app/${appId}/keys`)} title="Manage this app's API keys" className="text-xs font-semibold shrink-0 text-muted bg-transparent border-0 cursor-pointer">APIs</button>
                )}
                {publishResult ? (
                  <a href={publishResult.url} target="_blank" rel="noopener" className="text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 bg-success text-white no-underline">Live</a>
                ) : (
                  <button onClick={() => setPublishOpen(true)} className="text-xs px-2 py-0.5 rounded-full font-semibold shrink-0 bg-accent text-white border-0 cursor-pointer">Publish</button>
                )}
              </>
            ) : (
              <span className="text-xs text-muted">No preview yet</span>
            )}
          </div>
          <DeployStatusBar
            isStreaming={agent.isStreaming}
            deployState={agent.deployState}
            appId={appId}
            onRetry={(msg, cfg) => agent.sendMessage(msg, cfg)}
            retryConfig={{ provider, model, apiKey: getKey(provider), temperature, maxTokens: 16384 } as AIConfig}
            onSwitchToChat={() => setMobileTab("chat")}
          />
          {publishResult && (
            <div className="flex items-center gap-2 shrink-0 text-xs p-[0.35rem_0.75rem] bg-[color-mix(in_srgb,_var(--success)_10%,_var(--panel))] border-b border-line">
              <span className="text-success">●</span>
              <span>Published at <a href={publishResult.url} target="_blank" rel="noopener" className="font-semibold text-accent">{publishResult.url.replace("https://", "")}</a></span>
              {publishResult.audit && <span className="text-muted">· Audit: {publishResult.audit.pass} pass{publishResult.audit.fail > 0 ? `, ${publishResult.audit.fail} fail` : ""}</span>}
            </div>
          )}
          <div className="flex-1 flex items-center justify-center bg-(--paper-deep) min-h-0 overflow-hidden">
            {showPreview ? <iframe src={previewUrl} title="Preview" sandbox="allow-scripts allow-same-origin" className="w-full h-full border-0 bg-(--paper-deep)"  /> :
             agent.deployState ? <DeployLog state={agent.deployState} /> :
             <div className="text-center p-8 text-muted"><p>Your app will appear here once deployed.</p></div>}
          </div>
        </div>
      </div>
      {publishOpen && appId && (
        <PublishModal
          appId={appId}
          appName={currentProject?.name || appId}
          onClose={() => setPublishOpen(false)}
          onPublished={(url, audit) => setPublishResult({ url, audit })}
        />
      )}
    </div>
  );
}

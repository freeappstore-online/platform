import { useState, useCallback, useRef, useEffect } from "react";
import { AGENT_URL, API_URL, getSession } from "../lib/api";
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from "../lib/push";
import { useProjects, type Project } from "./useProjects";

export type { Project };

/** The full shape returned by useAgent — for typing components that receive it. */
export type Agent = ReturnType<typeof useAgent>;

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

export interface DeployState {
  phase: string;
  steps?: { name: string; status: string }[];
  appUrl?: string;
  error?: string;
}

export interface AIConfig {
  provider: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

interface AgentStreamEvent {
  type: string;
  data: string;
}

function agentAuthHeaders(): Record<string, string> {
  const s = getSession();
  return s?.token ? { Authorization: `Bearer ${s.token}` } : {};
}

const DEFAULT_MSG: ChatMessage[] = [{ role: "system", content: "Describe the app you want to build." }];

export function useAgent() {
  const projectsMgr = useProjects();
  const sessionId = projectsMgr.currentId;
  const [messages, setMessages] = useState<ChatMessage[]>(DEFAULT_MSG);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [tokensIn, setTokensIn] = useState(0);
  const [tokensOut, setTokensOut] = useState(0);
  const [deployState, setDeployState] = useState<DeployState | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  // Set just before loadHistory's setMessages so the D1-sync effect skips that
  // change — loading from the server shouldn't echo straight back to the server.
  const skipNextSyncRef = useRef(false);
  // Throttle reloads so visibilitychange + focus (which often both fire on
  // return) don't double-hit the server.
  const lastLoadRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Durable persistence: the agent's Durable Object is the authoritative
  // server-side record (it keeps running and saving even if this device
  // disconnects mid-build). D1 is the cross-device + post-eviction backup,
  // written here 500ms after streaming stops — short enough to feel
  // synchronous, long enough to batch the end-of-turn state burst.
  const d1TimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (skipNextSyncRef.current) { skipNextSyncRef.current = false; return; }
    if (isStreaming || messages.length <= 1 || !sessionId) return;
    if (d1TimerRef.current) clearTimeout(d1TimerRef.current);
    d1TimerRef.current = setTimeout(() => {
      const s = getSession();
      if (!s?.token) return;
      fetch(`${API_URL}/v1/agent/sessions/${sessionId}/messages`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messages.slice(-300) }),
      }).catch(() => { /* error UI is future work */ });
    }, 500);
    return () => { if (d1TimerRef.current) clearTimeout(d1TimerRef.current); };
  }, [sessionId, messages, isStreaming]);

  // Flush pending messages on tab close / app background so the 500ms debounce
  // window can't drop the last turn. keepalive lets the PUT outlive the page;
  // a plain PUT is idempotent so an occasional redundant flush is harmless.
  useEffect(() => {
    const flush = () => {
      const sid = sessionIdRef.current;
      const msgs = messagesRef.current;
      if (!sid || msgs.length <= 1 || isStreamingRef.current) return;
      const s = getSession();
      if (!s?.token) return;
      fetch(`${API_URL}/v1/agent/sessions/${sid}/messages`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs.slice(-300) }),
        keepalive: true,
      }).catch(() => {});
    };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  // Load authoritative history. Reads the DO first (freshest — includes a turn
  // that finished while this device was backgrounded), falls back to D1 if the
  // DO has evicted (24h idle). Stable across renders; keyed off sessionId only.
  const loadHistory = useCallback(async () => {
    if (!sessionId) { setMessages(DEFAULT_MSG); setDeployState(null); return; }
    if (isStreamingRef.current) return; // never clobber a live stream
    lastLoadRef.current = Date.now();
    const s = getSession();
    if (!s?.token) return;
    setIsLoadingHistory(true);
    setHistoryError(false);
    let doOk = false;
    let d1Ok = false;
    try {
      // 1. Durable Object — authoritative + freshest.
      const doRes = await fetch(`${AGENT_URL}/session/${sessionId}/history`, { headers: agentAuthHeaders() });
      if (doRes.ok) {
        doOk = true;
        const data = await doRes.json();
        const restored = restoreMessages(data.messages || []);
        if (restored.length > 0) {
          if (messagesRef.current.some((m) => m.role === "user") && isStreamingRef.current) return;
          skipNextSyncRef.current = true;
          setMessages(restored);
          setDeployState(data.deployStatus ?? null);
          // Reconcile a deploy that completed while this device was away:
          // the live SSE event that normally flips the project to "deployed"
          // was missed, so sync it from the DO's authoritative state.
          if (data.deployStatus?.phase === "live" && data.appId) {
            projectsMgr.markDeployed(sessionId, data.appId, data.deployStatus.appUrl || "");
          } else if (data.appName) {
            projectsMgr.rename(sessionId, data.appName);
          }
          return;
        }
      }
      // 2. D1 fallback — survives DO eviction.
      const d1Res = await fetch(`${API_URL}/v1/agent/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${s.token}` } });
      if (d1Res.ok) {
        d1Ok = true;
        const data = (await d1Res.json()) as { session?: { messages?: ChatMessage[]; deployState?: DeployState | null } };
        const msgs = data.session?.messages;
        if (messagesRef.current.some((m) => m.role === "user")) return;
        skipNextSyncRef.current = true;
        setMessages(msgs?.length ? msgs : DEFAULT_MSG);
        setDeployState(data.session?.deployState ?? null);
      }
      // Neither source was reachable — we have no authoritative answer.
      if (!doOk && !d1Ok) setHistoryError(true);
    } catch (err) {
      if ((err as Error).name !== "AbortError") { console.error("Failed to load history:", err); setHistoryError(true); }
    } finally {
      setIsLoadingHistory(false);
    }
    // markDeployed/rename are useCallback-stable; depending on the whole
    // projectsMgr object would change identity every render and loop.
  }, [sessionId, projectsMgr.markDeployed, projectsMgr.rename]);

  // Reload on project switch.
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Reload when the PWA/tab regains focus — this is the "I left mid-build and
  // came back" case. The DO kept working; this surfaces where it got to.
  // visibilitychange + focus often both fire on return, so throttle here
  // (not in loadHistory, which must always run on a project switch).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastLoadRef.current < 2000) return;
      loadHistory();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadHistory]);

  const resetUI = useCallback(() => {
    setMessages(DEFAULT_MSG);
    setDeployState(null);
    setTokensIn(0);
    setTokensOut(0);
  }, []);

  const createProject = useCallback((name: string, appId?: string) => {
    const id = projectsMgr.create(name, appId);
    resetUI();
    return id;
  }, [projectsMgr, resetUI]);

  const switchProject = useCallback((id: string) => {
    projectsMgr.switchTo(id);
    resetUI();
  }, [projectsMgr, resetUI]);

  // Subscribe to push notifications on first interaction
  const pushAsked = useRef(false);
  const subscribePush = useCallback(async () => {
    if (pushAsked.current || !sessionId) return;
    if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) return;
    pushAsked.current = true;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await fetch(`${AGENT_URL}/session/${sessionId}/push-subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuthHeaders() },
        body: JSON.stringify(sub.toJSON()),
      });
    } catch { /* push subscription failed — continue without */ }
  }, [sessionId]);

  const sendMessage = useCallback(async (message: string, aiConfig: AIConfig) => {
    if (!sessionId || isStreaming) return;
    subscribePush();
    setIsStreaming(true);
    setMessages((prev) => [...prev, { role: "user", content: message }, { role: "assistant", content: "" }]);
    let assistantText = "";
    let lastEventId: string | null = null;

    // Update the LAST assistant message in the array
    const updateAssistant = (content: string) => {
      setMessages((prev) => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === "assistant") {
            updated[i] = { role: "assistant", content };
            break;
          }
        }
        return updated;
      });
    };

    const handleStreamEvent = (evt: AgentStreamEvent) => {
      switch (evt.type) {
        case "text":
          assistantText += evt.data;
          updateAssistant(assistantText);
          break;
        case "tool_call": {
          const tc = JSON.parse(evt.data);
          setMessages((prev) => [...prev, { role: "tool", content: toolLabel(tc) }]);
          break;
        }
        case "tool_result": {
          const tr = JSON.parse(evt.data);
          if (tr.tool === "deploy") setDeployState({ phase: "provisioning", steps: [] });
          break;
        }
        case "usage": {
          const u = JSON.parse(evt.data);
          if (u.input) setTokensIn((p) => p + u.input);
          if (u.output) setTokensOut((p) => p + u.output);
          break;
        }
        case "deploy_status": {
          const ds = JSON.parse(evt.data);
          setDeployState(ds);
          if (ds.phase === "live" && ds.appUrl && sessionId) {
            const host = ds.appUrl.replace("https://", "").split("/")[0].split(".")[0];
            projectsMgr.markDeployed(sessionId, host, ds.appUrl);
            if (document.hidden && Notification.permission === "granted") {
              new Notification("Build complete!", { body: ds.appUrl, icon: "/icons/icon-192.png" });
            }
          }
          if (ds.phase === "error" && document.hidden && Notification.permission === "granted") {
            new Notification("Build failed", { body: ds.error?.slice(0, 100) || "Check VibeCode for details", icon: "/icons/icon-192.png" });
          }
          break;
        }
        case "error":
          assistantText += `\nError: ${evt.data}`;
          updateAssistant(assistantText);
          break;
      }
    };

    const readAgentStream = async (res: Response) => {
      if (!res.body) throw new Error("Empty response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const processBlock = (block: string) => {
        let id: string | null = null;
        const data: string[] = [];
        for (const rawLine of block.split("\n")) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length === 0) return;
        let evt: AgentStreamEvent;
        try {
          evt = JSON.parse(data.join("\n"));
        } catch {
          return;
        }
        if (id) lastEventId = id;
        handleStreamEvent(evt);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split(/\n\n/);
        buf = blocks.pop() || "";
        for (const block of blocks) processBlock(block);
      }
      if (buf.trim()) processBlock(buf);
    };

    const reconnectLive = async () => {
      const headers: Record<string, string> = { ...agentAuthHeaders() };
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;
      const res = await fetch(`${AGENT_URL}/session/${sessionId}/live`, { method: "GET", headers });
      if (!res.ok) throw new Error(`Live reconnect failed (${res.status})`);
      await readAgentStream(res);
    };

    try {
      const res = await fetch(`${AGENT_URL}/session/${sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuthHeaders() },
        body: JSON.stringify({ message, aiConfig }),
      });
      if (!res.ok) {
        if (res.status === 409) {
          await reconnectLive();
          return;
        }
        // The endpoint returns JSON ({error|hint}) on validation failures —
        // show the clean message, not the raw envelope. Matches what the
        // server records via recordErrorTurn so reload looks identical.
        const raw = await res.text();
        let msg = raw;
        try { const j = JSON.parse(raw); msg = j.hint || j.error || raw; } catch { /* plain text */ }
        updateAssistant(`Error: ${msg}`);
        return;
      }

      await readAgentStream(res);
      if (!assistantText) updateAssistant("(No response)");
      // Notify when AI response completes while tab is backgrounded
      if (assistantText && document.hidden && Notification.permission === "granted") {
        new Notification("VibeCode", { body: "AI response ready", icon: "/icons/icon-192.png" });
      }
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      const isTransient = errMsg.includes("reset") || errMsg.includes("network") || errMsg.includes("Failed to fetch") || errMsg.includes("aborted") || errMsg.includes("ECONNRESET");
      if (isTransient) {
        updateAssistant(`${assistantText}\n\n_Connection lost — reconnecting..._`);
        await new Promise(r => setTimeout(r, 1000));
        try {
          await reconnectLive();
          if (!assistantText) updateAssistant("(No response)");
        } catch {
          await loadHistory();
          updateAssistant(`${assistantText}\n\nConnection interrupted. Reopen this project to resume from the saved build state.`);
        }
      } else {
        updateAssistant(`Connection error: ${errMsg}`);
      }
    } finally {
      setIsStreaming(false);
    }
  }, [sessionId, isStreaming, subscribePush, projectsMgr, loadHistory]);

  return {
    messages, isStreaming, isLoadingHistory, historyError, tokensIn, tokensOut, deployState,
    projects: projectsMgr.projects, currentProjectId: projectsMgr.currentId,
    projectsLoading: projectsMgr.loading, projectsError: projectsMgr.loadError, reloadProjects: projectsMgr.reload,
    sendMessage, createProject, switchProject, retryHistory: loadHistory,
  };
}

// ── Helpers ──

// Creator-facing progress copy. Never include tool names, file paths, search
// patterns or tool output — the builder chat is for non-technical creators (#36).
function toolLabel(tc: { name: string }): string {
  switch (tc.name) {
    case "deploy": return "Deploying app...";
    case "push_update": return "Pushing update...";
    case "write_file": return "Writing code...";
    case "read_file": return "Reviewing the app...";
    case "list_files": return "Checking project files...";
    case "delete_file": return "Updating project files...";
    case "run_compliance_check": return "Checking quality...";
    case "search_files": return "Looking through the code...";
    default: return "Working on it...";
  }
}

// The Durable Object stores the rich agent-message format (assistant turns
// carry toolCalls; tool_result rows carry toolResults). Flatten that into the
// UI's {role, content} bubbles, the same shape D1 returns directly.
function restoreMessages(serverMessages: any[]): ChatMessage[] {
  const restored: ChatMessage[] = [];
  for (const m of serverMessages || []) {
    if (m.role === "assistant") {
      if (m.content) restored.push({ role: "assistant", content: m.content });
      for (const tc of m.toolCalls || []) restored.push({ role: "tool", content: toolLabel(tc) });
    } else if (m.role === "user") {
      // Platform-authored prompts (the #37 stall nudge) are not the creator's words.
      if (!m.internal) restored.push({ role: "user", content: m.content });
    } else if (m.role === "system") {
      restored.push({ role: "system", content: m.content });
    }
  }
  return restored;
}

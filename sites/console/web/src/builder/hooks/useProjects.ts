/** Project list — server (D1) is the only source of truth.
 *
 *  No localStorage cache of the project list. The only thing kept on the
 *  device is the *currently-selected* project id (a single short string),
 *  so a reload remembers which project you were on without a server hit.
 *
 *  Reads on mount + on user transition. Writes (create / rename / mark
 *  deployed) update React state optimistically and PUT to the server. */

import { useState, useCallback, useEffect } from "react";
import { useAuth } from "./useAuth";
import { API_URL, getSession } from "../lib/api";

export interface Project {
  id: string;           // agent session UUID
  name: string;
  createdAt: string;
  updatedAt: number;    // ms epoch — for "last edited" sort
  appId?: string;       // set after deploy
  appUrl?: string;      // preview URL
  deployed: boolean;
}

const CURRENT_KEY = "fas_current_project";

function authHeaders(): Record<string, string> {
  const s = getSession();
  return s?.token
    ? { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

interface ServerSession {
  id: string;
  name: string;
  appId?: string;
  appUrl?: string;
  deployed: boolean;
  createdAt: number;
  updatedAt: number;
}

function makeFetchError(status: number, endpoint: string): Error & { status: number } {
  const err = new Error(`${endpoint} returned HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

async function fetchSessions(signal: AbortSignal): Promise<Project[]> {
  const endpoint = `${API_URL}/v1/agent/sessions?limit=100`;
  const res = await fetch(endpoint, { headers: authHeaders(), signal });
  if (!res.ok) {
    console.error(`[useProjects] GET ${endpoint} failed: HTTP ${res.status}`);
    throw makeFetchError(res.status, endpoint);
  }
  const data = (await res.json()) as { sessions: ServerSession[] };
  return data.sessions.map((s) => ({
    id: s.id,
    name: s.name,
    appId: s.appId,
    appUrl: s.appUrl,
    deployed: s.deployed,
    createdAt: new Date(s.createdAt).toISOString(),
    updatedAt: s.updatedAt ?? s.createdAt,
  }));
}

function putSession(project: Project): void {
  // Optimistic UI + fire-and-forget PUT. Failures surface as the row not
  // re-appearing after the next fetch — acceptable for pre-launch.
  fetch(`${API_URL}/v1/agent/sessions/${project.id}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({
      name: project.name,
      appId: project.appId,
      appUrl: project.appUrl,
      deployed: project.deployed,
    }),
  }).catch(() => { /* error UI is future work */ });
}

/** False when no error; 'auth' when the session has expired (HTTP 401);
 *  'network' for all other non-2xx / connection failures. */
export type ProjectsLoadError = false | 'auth' | 'network';

export function useProjects() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ProjectsLoadError>(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [currentId, setCurrentIdState] = useState<string | null>(() => localStorage.getItem(CURRENT_KEY));

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  const setCurrentId = useCallback((id: string | null) => {
    setCurrentIdState(id);
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  }, []);

  useEffect(() => {
    // One-time cleanup: drop the legacy localStorage caches from the
    // pre-server-first design so we don't leave dead bytes behind.
    try {
      localStorage.removeItem("fas_projects");
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith("fas_chat:")) localStorage.removeItem(k);
      }
    } catch { /* QuotaExceeded etc — harmless */ }
  }, []);

  useEffect(() => {
    if (!user) {
      setProjects([]);
      setCurrentId(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(false);
    fetchSessions(ctrl.signal)
      .then((server) => {
        if (server.length === 0) {
          // First-time user — seed a starter project so the chat is usable immediately.
          const initial: Project = {
            id: crypto.randomUUID(),
            name: "New App",
            createdAt: new Date().toISOString(),
            updatedAt: Date.now(),
            deployed: false,
          };
          putSession(initial);
          setProjects([initial]);
          setCurrentId(initial.id);
        } else {
          setProjects(server);
          // Keep the stored "last project" if it still belongs to this user; else newest.
          const stored = localStorage.getItem(CURRENT_KEY);
          const validStored = stored && server.some((p) => p.id === stored);
          setCurrentId(validStored ? stored : server[0].id);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        const status = (err as { status?: number }).status;
        if (status === 401) {
          setLoadError('auth');
        } else {
          setLoadError('network');
        }
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [user?.id, reloadNonce, setCurrentId]);

  const create = useCallback((name: string, appId?: string) => {
    const id = crypto.randomUUID();
    const project: Project = {
      id,
      name,
      createdAt: new Date().toISOString(),
      updatedAt: Date.now(),
      deployed: !!appId,
      appId,
      appUrl: appId ? `https://free${appId.replace(/-/g, "")}app.pages.dev` : undefined,
    };
    setProjects((prev) => [project, ...prev]);
    setCurrentId(id);
    putSession(project);
    return id;
  }, [setCurrentId]);

  const switchTo = useCallback((id: string) => {
    setCurrentId(id);
  }, [setCurrentId]);

  const rename = useCallback((id: string, name: string) => {
    setProjects((prev) => {
      const existing = prev.find((p) => p.id === id);
      if (!existing || existing.name === name) return prev; // no change — skip PUT
      const updated = prev.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p));
      putSession(updated.find((p) => p.id === id)!);
      return updated;
    });
  }, []);

  const markDeployed = useCallback((sessionId: string, appId: string, appUrl: string) => {
    setProjects((prev) => {
      const existing = prev.find((p) => p.id === sessionId);
      // Idempotent: reconnect calls this on every focus for a deployed project.
      // Skip the state churn + PUT when nothing actually changed.
      if (existing?.deployed && existing.appId === appId && existing.appUrl === appUrl && existing.name === appId) {
        return prev;
      }
      const updated = prev.map((p) =>
        p.id === sessionId ? { ...p, appId, appUrl, deployed: true, name: appId, updatedAt: Date.now() } : p,
      );
      const project = updated.find((p) => p.id === sessionId);
      if (project) putSession(project);
      return updated;
    });
  }, []);

  return { projects, currentId, loading, loadError, reload, create, switchTo, rename, markDeployed } as const;
}

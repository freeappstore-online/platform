import { useEffect, useRef, useState } from "react";
import { AGENT_URL } from "../lib/api";

export type DevState = "working" | "deploying" | "error" | "idle";
export interface DevStatus {
  state: DevState;
  detail: string;
}

async function fetchStatus(id: string, signal: AbortSignal): Promise<DevStatus | null> {
  try {
    const res = await fetch(`${AGENT_URL}/session/${id}/status`, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { devStatus?: DevStatus };
    return data.devStatus ?? null;
  } catch {
    return null; // network/abort — treated as unknown (no dot change)
  }
}

/**
 * Live agent status for a set of apps, shown in the My Apps list.
 *
 * Snapshot on mount + on tab refocus (so returning from an app shows where
 * its agent got to). Then re-poll ONLY the apps that are actively
 * working/deploying, every 4s while the tab is visible — idle/live/error apps
 * are terminal-ish and aren't re-polled, which keeps the request volume bounded.
 */
export function useAppStatuses(ids: string[]): Map<string, DevStatus> {
  const [statuses, setStatuses] = useState<Map<string, DevStatus>>(new Map());
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const idsKey = ids.join(",");

  useEffect(() => {
    if (ids.length === 0) return;
    let cancelled = false;
    const ctrl = new AbortController();

    const merge = (entries: (readonly [string, DevStatus | null])[]) => {
      if (cancelled) return;
      setStatuses((prev) => {
        const next = new Map(prev);
        for (const [id, st] of entries) if (st) next.set(id, st);
        return next;
      });
    };

    const refreshAll = async () => {
      merge(await Promise.all(ids.map(async (id) => [id, await fetchStatus(id, ctrl.signal)] as const)));
    };

    const pollActive = async () => {
      const active = ids.filter((id) => {
        const s = statusesRef.current.get(id);
        return s?.state === "working" || s?.state === "deploying";
      });
      if (active.length === 0) return;
      merge(await Promise.all(active.map(async (id) => [id, await fetchStatus(id, ctrl.signal)] as const)));
    };

    refreshAll();
    const interval = setInterval(() => { if (document.visibilityState === "visible") pollActive(); }, 4000);
    const onVisible = () => { if (document.visibilityState === "visible") refreshAll(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [idsKey]);

  return statuses;
}

// #475: GET /status needs the owner's bearer like every other session route.

import { describe, expect, it } from "vitest";
import { AgentSession } from "./session";

type User = { id: string; login: string; githubLogin: string; roles: string[]; aud: string };
const ALICE: User = { id: "gh:1", login: "alice", githubLogin: "alice", roles: ["user"], aud: "console" };
const MALLORY: User = { id: "gh:2", login: "mallory", githubLogin: "mallory", roles: ["user"], aud: "console" };

function session(user: User, store = new Map<string, unknown>()) {
  const storage = {
    get: async (k: string) => structuredClone(store.get(k)),
    put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
    delete: async () => true,
    setAlarm: async () => {},
    getAlarm: async () => null,
    deleteAlarm: async () => {},
  };
  const state = { storage, waitUntil: () => {} } as unknown as DurableObjectState;
  const PLATFORM = { fetch: async () => Response.json(user) };
  return new AgentSession(state, { STORE: "apps", PLATFORM } as never);
}

const status = (s: AgentSession, headers: Record<string, string> = {}) =>
  s.fetch(new Request("https://do/status", { headers: { "X-Session-Id": "sess-1", ...headers } }));

describe("GET /status (#475)", () => {
  it("refuses a request with no bearer", async () => {
    expect((await status(session(ALICE))).status).toBe(401);
  });

  it("serves the owner and refuses anyone else", async () => {
    const store = new Map<string, unknown>();
    expect((await status(session(ALICE, store), { Authorization: "Bearer a" })).status).toBe(200);
    expect((await status(session(MALLORY, store), { Authorization: "Bearer m" })).status).toBe(403);
  });
});

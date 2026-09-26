// The real agent Worker in workerd (#7): requests enter through the Worker,
// are authenticated over the PLATFORM service binding, run in the real
// SQLite-backed AgentSession Durable Object, and sync to real D1. The backend
// and GitHub are stand-ins (vitest.runtime.ts).

import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const ALICE = { Authorization: "Bearer alice-session" };
const BOB = { Authorization: "Bearer bob-session" };

function call(path: string, init: RequestInit = {}) {
  return exports.default.fetch(new Request(`https://agent.freeappstore.online${path}`, init));
}

/** The index row the console writes before a session's first turn. */
function indexRow(sessionId: string, userId: string) {
  return env.DB.prepare("INSERT OR IGNORE INTO agent_sessions (session_id, user_id, name) VALUES (?, ?, 'New App')").bind(sessionId, userId).run();
}

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO apps (id, owner_login, created_at) VALUES ('dict', 'alice', 0)").run();
});

describe("worker entry → Durable Object", () => {
  it("answers health without touching a session", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: expect.any(String) });
  });

  it("binds a session to its first user over PLATFORM, and keeps others out", async () => {
    expect((await call("/session/s-owner/history")).status).toBe(401);

    const mine = await call("/session/s-owner/history", { headers: ALICE });
    expect(mine.status).toBe(200);

    // The owner lives in the Durable Object's storage, not the request.
    const theirs = await call("/session/s-owner/history", { headers: BOB });
    expect(theirs.status).toBe(403);
    expect(await theirs.json()).toEqual({ error: "Session belongs to another user" });
  });
});

describe("a chat turn: entry → PLATFORM key lookup → Durable Object → D1", () => {
  it("records a no-key turn, what was tried and who (not) paid, in D1", async () => {
    await indexRow("s-nokey", "gh:1");

    const res = await call("/session/s-nokey/chat", {
      method: "POST",
      headers: { ...ALICE, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "build a dictionary", aiConfig: { provider: "anthropic", model: "claude-sonnet-4-6" } }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/No API key found/);
    const row = await env.DB.prepare("SELECT messages, ai_provider, ai_model, ai_source FROM agent_sessions WHERE session_id = ?")
      .bind("s-nokey")
      .first<{ messages: string; ai_provider: string; ai_model: string; ai_source: string }>();
    expect(row).toMatchObject({ ai_provider: "anthropic", ai_model: "claude-sonnet-4-6", ai_source: "none" });
    expect(JSON.parse(row!.messages).map((m: { content: string }) => m.content)).toContain("build a dictionary");
  });

  it("records the backend's funding source for the turn (#16)", async () => {
    await indexRow("s-grant", "gh:2");

    await call("/session/s-grant/chat", {
      method: "POST",
      headers: { ...BOB, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", aiConfig: { provider: "anthropic", model: "claude-sonnet-4-6" } }),
    });

    const row = await env.DB.prepare("SELECT ai_source FROM agent_sessions WHERE session_id = ?").bind("s-grant").first();
    expect(row).toEqual({ ai_source: "grant_unfunded" });
  });
});

describe("opening an existing app (#12): D1 ownership + GitHub → Durable Object", () => {
  it("imports the owner's app into the session's storage", async () => {
    const res = await call("/session/s-import/import", {
      method: "POST",
      headers: { ...ALICE, "Content-Type": "application/json" },
      body: JSON.stringify({ appId: "dict" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, appId: "dict", fileCount: 2 });

    const files = (await (await call("/session/s-import/files", { headers: ALICE })).json()) as { files: { path: string }[] };
    expect(files.files.map((f) => f.path).sort()).toEqual(["package.json", "web/src/App.tsx"]);
  });

  it("refuses someone who doesn't own the app, per the D1 apps row", async () => {
    const res = await call("/session/s-steal/import", {
      method: "POST",
      headers: { ...BOB, "Content-Type": "application/json" },
      body: JSON.stringify({ appId: "dict" }),
    });
    expect(res.status).toBe(403);
  });
});

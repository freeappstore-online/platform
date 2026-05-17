/**
 * Integration tests against live api.freeappstore.online.
 *
 * Auth is handled by integration.setup.ts (globalSetup).
 * Locally: just have `gh` CLI logged in. No manual tokens.
 * CI: set FAS_SESSION_TOKEN or GITHUB_TOKEN env var.
 */
import { afterAll, describe, expect, it } from "vitest";

const API = "https://api.freeappstore.online";
const APP_ID = "mandarin-english";

const token = (): string => process.env.FAS_SESSION_TOKEN ?? "";
const skip = (): boolean => !token();

function authed(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, API), {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, ...init?.headers },
  });
}

// --- Auth ---

describe.skipIf(skip())("auth", () => {
  it("GET /v1/auth/me returns user", async () => {
    const res = await authed("/v1/auth/me");
    expect(res.ok).toBe(true);
    const user = await res.json();
    expect(user).toMatchObject({ id: expect.any(String), login: expect.any(String) });
  });

  it("rejects invalid token", async () => {
    const res = await fetch(`${API}/v1/auth/me`, {
      headers: { Authorization: "Bearer invalid" },
    });
    expect(res.status).toBe(401);
  });

  it("github/start redirects to GitHub OAuth", async () => {
    const res = await fetch(`${API}/v1/auth/github/start?app_id=test&return_to=https://freeappstore.online`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("github.com/login/oauth");
  });
});

// --- KV ---

describe.skipIf(skip())("kv", () => {
  const key = `test-${Date.now()}`;

  afterAll(async () => {
    await authed(`/v1/apps/${APP_ID}/kv/${key}`, { method: "DELETE" });
  });

  it("full lifecycle: put → get → delete → 404", async () => {
    // create
    const put = await authed(`/v1/apps/${APP_ID}/kv/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1 }),
    });
    expect(put.status).toBe(204);

    // read
    const get = await authed(`/v1/apps/${APP_ID}/kv/${key}`);
    expect(get.ok).toBe(true);
    expect(await get.json()).toEqual({ v: 1 });

    // delete
    const del = await authed(`/v1/apps/${APP_ID}/kv/${key}`, { method: "DELETE" });
    expect(del.status).toBe(204);

    // gone
    const gone = await authed(`/v1/apps/${APP_ID}/kv/${key}`);
    expect(gone.status).toBe(404);
  });

  it("enforces 64KB value limit", async () => {
    const res = await authed(`/v1/apps/${APP_ID}/kv/too-big`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("x".repeat(65 * 1024)),
    });
    expect(res.ok).toBe(false);
  });

  it("list keys returns array (new endpoint)", async () => {
    // Create a key first
    await authed(`/v1/apps/${APP_ID}/kv/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list_test: true }),
    });
    const listRes = await authed(`/v1/apps/${APP_ID}/kv`);
    expect(listRes.ok).toBe(true);
    const keys = await listRes.json();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys).toContain(key);
  });

  it("list keys with prefix filter", async () => {
    const listRes = await authed(`/v1/apps/${APP_ID}/kv?prefix=test-`);
    expect(listRes.ok).toBe(true);
    const keys = await listRes.json();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.every((k: string) => k.startsWith("test-"))).toBe(true);
  });
});

// --- Counters ---

describe.skipIf(skip())("counters", () => {
  const counterKey = `test-${Date.now()}`;

  it("GET counters returns object (public, no auth)", async () => {
    const res = await fetch(`${API}/v1/apps/${APP_ID}/counters`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(typeof data).toBe("object");
  });

  it("POST increments counter (requires auth)", async () => {
    const res = await authed(`/v1/apps/${APP_ID}/counters/${counterKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ increment: 3 }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.value).toBe(3);
  });

  it("GET single counter returns value", async () => {
    const res = await fetch(`${API}/v1/apps/${APP_ID}/counters/${counterKey}`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.value).toBe(3);
  });

  it("rejects increment without auth", async () => {
    const res = await fetch(`${API}/v1/apps/${APP_ID}/counters/${counterKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ increment: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

// --- Apps ---

describe.skipIf(skip())("apps", () => {
  it("GET /v1/apps/mine returns array", async () => {
    const res = await authed("/v1/apps/mine");
    expect(res.ok).toBe(true);
    expect((await res.json()).apps).toEqual(expect.any(Array));
  });
});

// --- Rooms ---

describe.skipIf(skip())("rooms", () => {
  it("WebSocket connects and closes", async () => {
    const { WebSocket } = await import("ws");
    const url = `wss://api.freeappstore.online/v1/apps/${APP_ID}/rooms/test-${Date.now()}?token=${token()}`;

    const ok = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 10_000);
      ws.on("open", () => {
        clearTimeout(t);
        ws.close();
        resolve(true);
      });
      ws.on("error", () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    expect(ok).toBe(true);
  });
});

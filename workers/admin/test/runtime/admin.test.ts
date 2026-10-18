// The real admin Worker in workerd (#7): /api/provision behind the FAS
// backend's service-binding token, admin sessions checked over the BACKEND_FAS
// binding, and the provisioned rows landing in real D1. The backend, GitHub
// and the Cloudflare API are stand-ins that reject wrong credentials
// (vitest.runtime.mts), so a successful step proves the right token was sent.

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** Must match PROVISION_TOKEN in vitest.runtime.mts. */
const PROVISION_TOKEN = "test-provision-token";

type Step = { name: string; status: string; detail?: string };

function call(path: string, init: RequestInit = {}) {
  return exports.default.fetch(new Request(`https://admin.freeappstore.online${path}`, init));
}

function provision(id: string, headers: Record<string, string>) {
  return call("/api/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      id,
      name: `App ${id}`,
      category: "utilities",
      icon: "x",
      iconBg: "#fff",
      description: "d",
      store: "apps",
      creatorGithub: "alice",
    }),
  });
}

const step = (steps: Step[], name: string) => steps.find((s) => s.name === name);

describe("service-binding auth: the backend's /v1/publish → /api/provision", () => {
  it("provisions with the shared token: repo, D1 rows, registry, analytics persisted over BACKEND_FAS", async () => {
    const res = await provision("svc-app", { "X-Internal-Token": PROVISION_TOKEN });
    const body = (await res.json()) as { success: boolean; steps: Step[] };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(step(body.steps, "GitHub repo")?.status).toBe("ok");
    expect(step(body.steps, "Hosting route")?.status).toBe("ok");
    expect(step(body.steps, "Store registry")?.status).toBe("ok");
    // The site tag reached the backend over the service binding, carrying the token.
    expect(step(body.steps, "CF Web Analytics")?.detail).toContain("persisted to FAS backend");

    // Real D1: the host Worker can now route the app, and ownership is recorded.
    const route = await env.DB.prepare("SELECT r2_prefix, store, hosted_on FROM routes WHERE slug = ? AND zone = ?")
      .bind("svc-app", "freeappstore.online")
      .first();
    expect(route).toEqual({ r2_prefix: "apps/svc-app", store: "apps", hosted_on: "r2" });
    const app = await env.DB.prepare("SELECT owner_login FROM apps WHERE id = ?").bind("svc-app").first();
    expect(app).toEqual({ owner_login: "alice" });
  });

  it("is idempotent: re-provisioning keeps one route and the original owner", async () => {
    await provision("again-app", { "X-Internal-Token": PROVISION_TOKEN });
    const res = await provision("again-app", { "X-Internal-Token": PROVISION_TOKEN });
    const body = (await res.json()) as { success: boolean; steps: Step[] };

    expect(res.status).toBe(200);
    expect(step(body.steps, "GitHub repo")?.status).toBe("skip");
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM routes WHERE slug = ?").bind("again-app").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("refuses a missing or wrong token, and writes nothing", async () => {
    expect((await provision("no-token", {})).status).toBe(401);
    expect((await provision("bad-token", { "X-Internal-Token": "nope" })).status).toBe(401);

    const row = await env.DB.prepare("SELECT 1 FROM routes WHERE slug IN ('no-token', 'bad-token')").first();
    expect(row).toBeNull();
  });
});

describe("admin sessions over the BACKEND_FAS service binding", () => {
  it("lets an admin session in", async () => {
    const res = await call("/api/ping", { headers: { Authorization: "Bearer admin-session" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, worker: "freeappstore-admin" });
  });

  it("forbids a signed-in non-admin and rejects an unknown session", async () => {
    expect((await call("/api/ping", { headers: { Authorization: "Bearer user-session" } })).status).toBe(403);
    expect((await call("/api/ping", { headers: { Authorization: "Bearer forged" } })).status).toBe(401);
    expect((await call("/api/ping")).status).toBe(401);
  });

  it("rate-limits a human admin's provisions in real KV, but not the backend's", async () => {
    const admin = { Authorization: "Bearer admin-session" };
    for (const id of ["rl-1", "rl-2", "rl-3"]) expect((await provision(id, admin)).status).toBe(200);

    const limited = await provision("rl-4", admin);
    expect(limited.status).toBe(429);
    expect(await env.CREATORS.get("ratelimit:ops:provision")).toBe("3");

    // The backend's own calls aren't counted against anyone.
    expect((await provision("rl-svc", { "X-Internal-Token": PROVISION_TOKEN })).status).toBe(200);
  });
});

describe("POST /api/apps/transfer-owner (#274)", () => {
  const admin = { Authorization: "Bearer admin-session", "Content-Type": "application/json" };

  async function seed() {
    await env.DB.prepare("DELETE FROM app_owner_transfers WHERE app_id = 'owner-xfer'").run();
    await env.DB.prepare("DELETE FROM apps WHERE id = 'owner-xfer'").run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO users (id, github_id, github_login, created_at, provider, provider_id, display_name)
       VALUES ('gh:xfer-to', 91001, 'xfer-to', 1, 'github', '91001', 'xfer-to')`,
    ).run();
    await env.DB.prepare("INSERT INTO apps (id, owner_login, created_at) VALUES ('owner-xfer', 'xfer-from', 1)").run();
  }

  function post(body: Record<string, string>, headers: Record<string, string>) {
    return call("/api/apps/transfer-owner", {
      method: "POST",
      headers,
      body: JSON.stringify({ app_id: "owner-xfer", reason: "runtime test", ...body }),
    });
  }

  it("refuses a non-admin, a wrong owner, and an unknown app, then transfers and writes the audit", async () => {
    await seed();

    const forbidden = await post(
      { from_login: "xfer-from", to_login: "xfer-to" },
      { Authorization: "Bearer user-session", "Content-Type": "application/json" },
    );
    expect(forbidden.status).toBe(403);

    const mismatch = await post({ from_login: "someone-else", to_login: "xfer-to" }, admin);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ error: "owner mismatch", owner_login: "xfer-from" });

    const missing = await call("/api/apps/transfer-owner", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ app_id: "no-such-app", from_login: "xfer-from", to_login: "xfer-to", reason: "nope" }),
    });
    expect(missing.status).toBe(404);

    const unknownLogin = await post({ from_login: "xfer-from", to_login: "not-a-user" }, admin);
    expect(unknownLogin.status).toBe(400);

    // xfer-from is the recorded owner and has no users row. The new owner does.
    const ok = await post({ from_login: "xfer-from", to_login: "xfer-to" }, admin);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, from_login: "xfer-from", to_login: "xfer-to", owner_login: "xfer-to" });

    const owner = await env.DB.prepare("SELECT owner_login FROM apps WHERE id = 'owner-xfer'").first<{ owner_login: string }>();
    expect(owner).toEqual({ owner_login: "xfer-to" });
    const audit = await env.DB.prepare(
      "SELECT from_login, to_login, reason, actor_login FROM app_owner_transfers WHERE app_id = 'owner-xfer'",
    ).first();
    expect(audit).toEqual({ from_login: "xfer-from", to_login: "xfer-to", reason: "runtime test", actor_login: "ops" });

    const listed = await call("/api/apps/transfer-owner?app_id=owner-xfer", { headers: { Authorization: "Bearer admin-session" } });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { transfers: Array<{ actor_login: string }> };
    expect(body.transfers.map((row) => row.actor_login)).toEqual(["ops"]);
  });
});

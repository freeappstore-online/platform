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

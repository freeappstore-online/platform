import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthResult } from "./auth";
import type { Env } from "./helpers";
import worker from "./index";
import type { GhFn } from "./publish";
import { transferOwnerRoutes } from "./routes/transfer-owner";
import { actorLogin, listOwnerTransfers, moveRepoAccess, parseTransferBody, type TransferAudit, transferAppOwner } from "./transfer-owner";

interface Mem {
  apps: Map<string, string>;
  users: Set<string>;
  audits: TransferAudit[];
}

function memoryDb(seed: { apps?: Record<string, string>; users?: string[] } = {}): D1Database & { mem: Mem } {
  const mem: Mem = {
    apps: new Map(Object.entries(seed.apps ?? {})),
    users: new Set(seed.users ?? []),
    audits: [],
  };
  let nextId = 1;

  function apply(sql: string, binds: unknown[]) {
    const trimmed = sql.trim();
    if (trimmed.startsWith("SELECT id, owner_login FROM apps")) {
      const id = String(binds[0]);
      const owner = mem.apps.get(id);
      return { changes: 0, last_row_id: 0, row: owner === undefined ? null : { id, owner_login: owner }, rows: [] as TransferAudit[] };
    }
    if (trimmed.startsWith("SELECT github_login FROM users")) {
      const want = String(binds[0]).toLowerCase();
      const found = [...mem.users].find((login) => login.toLowerCase() === want) ?? null;
      return { changes: 0, last_row_id: 0, row: found ? { github_login: found } : null, rows: [] as TransferAudit[] };
    }
    if (trimmed.startsWith("INSERT INTO app_owner_transfers")) {
      const appId = String(binds[0]);
      const toLogin = String(binds[1]);
      const reason = String(binds[2]);
      const actor = String(binds[3]);
      const created = Number(binds[4]);
      const fromLogin = String(binds[5]);
      const owner = mem.apps.get(appId);
      const match = owner !== undefined && owner.toLowerCase() === fromLogin.toLowerCase() && owner.toLowerCase() !== toLogin.toLowerCase();
      if (!match) return { changes: 0, last_row_id: 0, row: null, rows: [] as TransferAudit[] };
      const id = nextId++;
      mem.audits.push({
        id,
        app_id: appId,
        from_login: owner!,
        to_login: toLogin,
        reason,
        actor_login: actor,
        created_at: created,
      });
      return { changes: 1, last_row_id: id, row: null, rows: [] as TransferAudit[] };
    }
    if (trimmed.startsWith("UPDATE apps")) {
      const toLogin = String(binds[0]);
      const appId = String(binds[1]);
      const fromLogin = String(binds[2]);
      const owner = mem.apps.get(appId);
      const match = owner !== undefined && owner.toLowerCase() === fromLogin.toLowerCase() && owner.toLowerCase() !== toLogin.toLowerCase();
      if (!match) return { changes: 0, last_row_id: 0, row: null, rows: [] as TransferAudit[] };
      mem.apps.set(appId, toLogin);
      return { changes: 1, last_row_id: 0, row: null, rows: [] as TransferAudit[] };
    }
    if (trimmed.startsWith("SELECT id, app_id")) {
      const appId = String(binds[0]);
      const rows = mem.audits
        .filter((row) => row.app_id === appId)
        .sort((a, b) => b.id - a.id)
        .slice(0, 50);
      return { changes: 0, last_row_id: 0, row: null, rows };
    }
    throw new Error(`unexpected sql: ${trimmed}`);
  }

  function prepare(sql: string) {
    const stmt = {
      binds: [] as unknown[],
      bind(...args: unknown[]) {
        stmt.binds = args;
        return stmt;
      },
      async first() {
        return apply(sql, stmt.binds).row;
      },
      async all() {
        return { results: apply(sql, stmt.binds).rows };
      },
      async run() {
        const result = apply(sql, stmt.binds);
        return { meta: { changes: result.changes, last_row_id: result.last_row_id } };
      },
    };
    return stmt;
  }

  const db = {
    mem,
    prepare,
    async batch(stmts: Array<{ run: () => Promise<{ meta: { changes: number; last_row_id: number } }> }>) {
      const out = [];
      for (const stmt of stmts) out.push(await stmt.run());
      return out;
    },
  };
  return db as unknown as D1Database & { mem: Mem };
}

const input = {
  app_id: "watertracker",
  from_login: "mathanghial",
  to_login: "serge-ivo",
  reason: "reuse the empty repo for wave 1",
};

function seeded() {
  return memoryDb({
    apps: { watertracker: "mathanghial" },
    users: ["serge-ivo"],
  });
}

describe("parseTransferBody", () => {
  it("trims a complete body", () => {
    expect(parseTransferBody({ ...input, reason: "  because  " })).toEqual({
      ok: true,
      value: { ...input, reason: "because" },
    });
  });

  it("refuses empty logins, an empty reason, and a bad app id", () => {
    expect(parseTransferBody({ ...input, from_login: "  " })).toMatchObject({ ok: false, error: "from_login is required" });
    expect(parseTransferBody({ ...input, to_login: "" })).toMatchObject({ ok: false, error: "to_login is required" });
    expect(parseTransferBody({ ...input, reason: "" })).toMatchObject({ ok: false, error: "reason is required" });
    expect(parseTransferBody({ ...input, app_id: "Nope" })).toMatchObject({ ok: false, error: "invalid app id" });
  });
});

describe("actorLogin", () => {
  const admin: AuthResult = { ok: true, kind: "admin", user: { id: "gh:1", login: "Ops", githubLogin: "serge-ivo" } };

  it("uses the admin github login", () => {
    expect(actorLogin(admin)).toBe("serge-ivo");
  });

  it("refuses a service token, a non-admin, and a signed-out caller", () => {
    expect(actorLogin({ ok: true, kind: "service" })).toBeNull();
    expect(actorLogin({ ok: true, kind: "local" })).toBeNull();
    expect(actorLogin({ ok: false, status: 403, error: "admin only" })).toBeNull();
    expect(actorLogin(null)).toBeNull();
  });
});

describe("transferAppOwner", () => {
  it("transfers, records the audit, and stores the canonical new login", async () => {
    const db = seeded();
    const outcome = await transferAppOwner(db, { ...input, from_login: "MathAnghial", to_login: "Serge-Ivo" }, "serge-ivo");

    expect(outcome.status).toBe(200);
    if (outcome.status !== 200) return;
    expect(outcome.body).toMatchObject({
      ok: true,
      app_id: "watertracker",
      from_login: "mathanghial",
      to_login: "serge-ivo",
      owner_login: "serge-ivo",
      audit_id: 1,
    });
    expect(db.mem.apps.get("watertracker")).toBe("serge-ivo");

    const audits = await listOwnerTransfers(db, "watertracker");
    expect(audits).toEqual([
      {
        id: 1,
        app_id: "watertracker",
        from_login: "mathanghial",
        to_login: "serge-ivo",
        reason: input.reason,
        actor_login: "serge-ivo",
        created_at: audits[0]!.created_at,
      },
    ]);
    expect(audits[0]!.created_at).toBeGreaterThan(0);
  });

  it("refuses a wrong from_login and leaves the row and the audit alone", async () => {
    const db = seeded();
    const outcome = await transferAppOwner(db, { ...input, from_login: "someone-else" }, "serge-ivo");
    expect(outcome).toEqual({
      status: 409,
      body: { error: "owner mismatch", app_id: "watertracker", owner_login: "mathanghial" },
    });
    expect(db.mem.apps.get("watertracker")).toBe("mathanghial");
    expect(db.mem.audits).toEqual([]);
  });

  it("refuses an unknown app", async () => {
    const db = seeded();
    const outcome = await transferAppOwner(db, { ...input, app_id: "sipday" }, "serge-ivo");
    expect(outcome).toEqual({ status: 404, body: { error: "unknown app", app_id: "sipday" } });
    expect(db.mem.audits).toEqual([]);
  });

  it("refuses an unknown new owner", async () => {
    const db = seeded();
    const outcome = await transferAppOwner(db, { ...input, to_login: "not-a-user" }, "serge-ivo");
    expect(outcome).toEqual({ status: 400, body: { error: "unknown login", login: "not-a-user" } });
    expect(db.mem.apps.get("watertracker")).toBe("mathanghial");
    expect(db.mem.audits).toEqual([]);
  });

  it("moves an app whose current owner has no users row", async () => {
    const db = seeded();
    expect(db.mem.users.has("mathanghial")).toBe(false);
    const outcome = await transferAppOwner(db, input, "serge-ivo");
    expect(outcome.status).toBe(200);
    expect(db.mem.apps.get("watertracker")).toBe("serge-ivo");
  });

  it("does not write a transfer when the app is already owned by the target", async () => {
    const db = memoryDb({ apps: { watertracker: "serge-ivo" }, users: ["serge-ivo"] });
    const outcome = await transferAppOwner(db, { ...input, from_login: "serge-ivo", to_login: "serge-ivo" }, "ops");
    expect(outcome).toEqual({ status: 400, body: { error: "app is already owned by this login", login: "serge-ivo" } });
    expect(db.mem.audits).toEqual([]);
  });
});

describe("POST /api/apps/transfer-owner", () => {
  const admin: AuthResult = { ok: true, kind: "admin", user: { id: "gh:1", login: "serge-ivo", githubLogin: "serge-ivo" } };

  // The route moves repo access through the GitHub API (#279); never the network.
  let ghCalls: string[];
  beforeEach(() => {
    ghCalls = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      ghCalls.push(`${init?.method ?? "GET"} ${url.replace("https://api.github.com", "")}`);
      if (url.endsWith("/invitations")) return new Response("[]", { status: 200 });
      return new Response(null, { status: 204 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves repo push access to the new owner and reports it", async () => {
    const res = await call(seeded(), admin, post(input));
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ ok: true, repo_access: { granted: true, revoked: true, errors: [] } });
    expect(ghCalls).toEqual([
      "PUT /repos/freeappstore-online/watertracker/collaborators/serge-ivo",
      "DELETE /repos/freeappstore-online/watertracker/collaborators/mathanghial",
      "GET /repos/freeappstore-online/watertracker/invitations",
    ]);
  });

  it("doesn't touch GitHub when the transfer is refused", async () => {
    const res = await call(seeded(), admin, post({ ...input, from_login: "someone-else" }));
    expect(res!.status).toBe(409);
    expect(ghCalls).toEqual([]);
  });

  function call(db: D1Database, auth: AuthResult | null, init: RequestInit, path = "/api/apps/transfer-owner") {
    const request = new Request(`https://admin.freeappstore.online${path}`, init);
    const env = { DB: db } as Env;
    return transferOwnerRoutes({ request, env, url: new URL(request.url), auth });
  }

  const post = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("transfers through the route and lists the audit for an admin", async () => {
    const db = seeded();
    const res = await call(db, admin, post(input));
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Cache-Control")).toBe("no-store");
    expect(await res!.json()).toMatchObject({ ok: true, owner_login: "serge-ivo", audit_id: 1 });

    const listed = await call(db, admin, { method: "GET" }, "/api/apps/transfer-owner?app_id=watertracker");
    expect(listed!.status).toBe(200);
    const body = (await listed!.json()) as { transfers: TransferAudit[] };
    expect(body.transfers).toHaveLength(1);
    expect(body.transfers[0]).toMatchObject({
      from_login: "mathanghial",
      to_login: "serge-ivo",
      actor_login: "serge-ivo",
      reason: input.reason,
    });
  });

  it("refuses a service token even though the auth gate would let it through", async () => {
    const db = seeded();
    const res = await call(db, { ok: true, kind: "service" }, post(input));
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({ error: "admin session required" });
    expect(db.mem.apps.get("watertracker")).toBe("mathanghial");
  });

  it("ignores other methods and paths", async () => {
    const db = seeded();
    expect(await call(db, admin, { method: "PUT" })).toBeNull();
    expect(await call(db, admin, post(input), "/api/apps/transfer-owner/extra")).toBeNull();
  });
});

describe("transfer route through the worker auth gate", () => {
  function fetchAs(headers: Record<string, string>, backendBody: unknown, status = 200) {
    const backend = {
      fetch: async () => new Response(JSON.stringify(backendBody), { status, headers: { "Content-Type": "application/json" } }),
    };
    return worker.fetch(
      new Request("https://admin.freeappstore.online/api/apps/transfer-owner", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(input),
      }),
      { ADMIN_PROVISION_TOKEN: "tok", BACKEND_FAS: backend, DB: memoryDb() } as unknown as Env,
    );
  }

  it("rejects a signed-in non-admin before the transfer runs", async () => {
    const res = await fetchAs({ Authorization: "Bearer user" }, { id: "u", login: "alice", roles: ["user"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin only" });
  });

  it("rejects a missing session", async () => {
    const res = await fetchAs({}, { error: "nope" }, 401);
    expect(res.status).toBe(401);
  });
});

describe("moveRepoAccess (#279)", () => {
  function fakeGh(responses: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const gh: GhFn = async (path, method) => {
      const key = `${method ?? "GET"} ${path}`;
      calls.push(key);
      return responses[key] ?? (key.endsWith("/invitations") ? { __status: 200, __body: [] } : { __status: 204, __empty: true });
    };
    return { gh, calls };
  }
  const repo = "/repos/freeappstore-online/timer";

  it("grants the new owner push before removing the previous owner", async () => {
    const { gh, calls } = fakeGh();
    expect(await moveRepoAccess(gh, "freeappstore-online", "timer", "alice", "bob")).toEqual({ granted: true, revoked: true, errors: [] });
    expect(calls).toEqual([`PUT ${repo}/collaborators/bob`, `DELETE ${repo}/collaborators/alice`, `GET ${repo}/invitations`]);
  });

  it("cancels the previous owner's pending invite (only theirs)", async () => {
    const { gh, calls } = fakeGh({
      [`GET ${repo}/invitations`]: {
        __status: 200,
        __body: [
          { id: 7, invitee: { login: "Alice" } },
          { id: 8, invitee: { login: "carol" } },
        ],
      },
    });
    const r = await moveRepoAccess(gh, "freeappstore-online", "timer", "alice", "bob");
    expect(r.revoked).toBe(true);
    expect(calls).toContain(`DELETE ${repo}/invitations/7`);
    expect(calls).not.toContain(`DELETE ${repo}/invitations/8`);
  });

  it("treats a previous owner who isn't a collaborator (404) as revoked", async () => {
    const { gh } = fakeGh({ [`DELETE ${repo}/collaborators/alice`]: { __status: 404, message: "Not Found" } });
    expect((await moveRepoAccess(gh, "freeappstore-online", "timer", "alice", "bob")).revoked).toBe(true);
  });

  it("leaves the org's own access alone", async () => {
    const { gh, calls } = fakeGh();
    await moveRepoAccess(gh, "freeappstore-online", "timer", "FreeAppStore-Online", "bob");
    expect(calls).toEqual([`PUT ${repo}/collaborators/bob`]);
  });

  it("reports GitHub failures instead of throwing", async () => {
    const { gh } = fakeGh({
      [`PUT ${repo}/collaborators/bob`]: { __status: 422, message: "Validation Failed" },
      [`DELETE ${repo}/collaborators/alice`]: { __status: 500, message: "Server Error" },
    });
    const r = await moveRepoAccess(gh, "freeappstore-online", "timer", "alice", "bob");
    expect(r).toMatchObject({ granted: false, revoked: false });
    expect(r.errors).toEqual(["grant bob: Validation Failed", "remove alice: Server Error"]);
  });
});

// #12: open an existing app in VibeCode by importing its repo. Drives the real
// AgentSession /import route; the platform auth API, D1 and GitHub are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_TOTAL_BYTES } from "./repo-import";
import { AgentSession } from "./session";

type User = { id: string; login: string; githubLogin: string; roles: string[] };
const ALICE: User = { id: "gh:1", login: "alice", githubLogin: "alice", roles: ["user", "creator"] };
const MALLORY: User = { id: "gh:2", login: "mallory", githubLogin: "mallory", roles: ["user"] };
const ADMIN: User = { id: "gh:3", login: "ops", githubLogin: "ops", roles: ["user", "admin"] };
/** A Google user whose chosen display name is alice's GitHub login. */
const IMPOSTOR: User = { id: "google:9", login: "alice", githubLogin: "mallory9", roles: ["user"] };

/** GitHub repo: path -> content. */
type Repo = Record<string, string>;

function fakeState() {
  const store = new Map<string, unknown>();
  const storage = {
    get: async (k: string) => structuredClone(store.get(k)),
    put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
    delete: async (k: string | string[]) => {
      for (const key of [k].flat()) store.delete(key);
      return true;
    },
    setAlarm: async () => {},
    getAlarm: async () => null,
    deleteAlarm: async () => {},
  };
  return { state: { storage, waitUntil: () => {} } as unknown as DurableObjectState, store };
}

/** `apps` rows: id -> [owner_login, display_name]. */
function fakeEnv(user: User, apps: Record<string, [string, string | null]>) {
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          const row = sql.includes("FROM apps WHERE id") ? apps[args[0] as string] : undefined;
          return row ? { owner_login: row[0], display_name: row[1] } : null;
        },
        run: async () => ({}),
      }),
    }),
  };
  const PLATFORM = { fetch: async () => Response.json(user) };
  return { STORE: "apps", GITHUB_TOKEN: "gh", DB, PLATFORM } as any;
}

/** Serve `repos` through the GitHub tree + contents APIs; `sizes` overrides reported sizes. */
function mockGitHub(repos: Record<string, Repo>, sizes: Record<string, number> = {}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const tree = url.match(/repos\/freeappstore-online\/([^/]+)\/git\/trees\/main/);
    if (tree) {
      const repo = repos[tree[1]!];
      if (!repo) return new Response("{}", { status: 404 });
      return Response.json({
        tree: Object.entries(repo).map(([path, content]) => ({ path, type: "blob", size: sizes[path] ?? content.length })),
      });
    }
    const file = url.match(/repos\/freeappstore-online\/([^/]+)\/contents\/(.+)\?ref=main$/);
    if (file) {
      const content = repos[file[1]!]?.[file[2]!];
      return content === undefined ? new Response("", { status: 404 }) : new Response(content);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

async function importApp(session: AgentSession, appId: string) {
  const res = await session.fetch(
    new Request("https://do/import", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "X-Session-Id": "sess-1", "Content-Type": "application/json" },
      body: JSON.stringify({ appId }),
    }),
  );
  return { status: res.status, body: (await res.json()) as any };
}

const DICT: Repo = {
  "web/src/App.tsx": "export default function App() { return <main>Dictionary</main>; }",
  "web/src/index.css": ":root { --paper: #fff; }",
  "package.json": '{ "name": "dict" }',
  // Not source the session should hold:
  ".github/workflows/deploy.yml": "on: push",
  "pnpm-lock.yaml": "lockfileVersion: 9",
  "node_modules/x/index.js": "module.exports = 1",
  "web/public/icon.png": "\u0089PNG",
};

const originalFetch = globalThis.fetch;
beforeEach(() => mockGitHub({ dict: DICT }));
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("POST /import — who may open an app (#12)", () => {
  it("the owner imports the real repo source, bound to the app", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv(ALICE, { dict: ["alice", "Dictionary"] }));

    const { status, body } = await importApp(session, "dict");

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, appId: "dict", appUrl: "https://dict.freeappstore.online", appName: "Dictionary", fileCount: 3 });
    const saved = store.get("session") as any;
    // The repo's files, not the scaffold; no workflows, lockfiles, vendor or binaries.
    expect(Object.keys(saved.files).sort()).toEqual(["package.json", "web/src/App.tsx", "web/src/index.css"]);
    expect(saved.files["web/src/App.tsx"]).toContain("Dictionary");
    // Baseline = the repo, so push_update sends only real edits.
    expect(saved.baselineFiles).toEqual(saved.files);
    expect(saved).toMatchObject({
      appId: "dict",
      appName: "Dictionary",
      deployStatus: { phase: "live", appUrl: "https://dict.freeappstore.online" },
    });
  });

  it("matches the owner's GitHub login case-insensitively", async () => {
    const { state } = fakeState();
    const session = new AgentSession(state, fakeEnv(ALICE, { dict: ["Alice", null] }));
    expect((await importApp(session, "dict")).status).toBe(200);
  });

  it("a platform admin can open any app for troubleshooting", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv(ADMIN, { dict: ["alice", null] }));

    expect((await importApp(session, "dict")).status).toBe(200);
    expect((store.get("session") as any).appId).toBe("dict");
  });

  it("anyone else is refused, and the session is left untouched", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv(MALLORY, { dict: ["alice", null] }));

    const { status, body } = await importApp(session, "dict");

    expect(status).toBe(403);
    expect(body.error).toMatch(/do not own "dict"/);
    const saved = store.get("session") as any;
    expect(saved.appId).toBeNull();
    expect(saved.files["web/src/App.tsx"]).not.toContain("Dictionary");
  });

  it("a display name equal to the owner's login is not ownership", async () => {
    const { state } = fakeState();
    const session = new AgentSession(state, fakeEnv(IMPOSTOR, { dict: ["alice", null] }));
    expect((await importApp(session, "dict")).status).toBe(403);
  });

  it("an app with no ownership record can't be opened by a non-admin", async () => {
    const { state } = fakeState();
    const session = new AgentSession(state, fakeEnv(ALICE, {}));
    expect((await importApp(session, "dict")).status).toBe(404);
  });

  it("refuses to re-point a session already bound to another app", async () => {
    mockGitHub({ dict: DICT, other: { "web/src/App.tsx": "export default 1" } });
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv(ALICE, { dict: ["alice", null], other: ["alice", null] }));
    expect((await importApp(session, "dict")).status).toBe(200);

    const { status, body } = await importApp(session, "other");

    expect(status).toBe(409);
    expect(body.error).toMatch(/different app/);
    expect((store.get("session") as any).appId).toBe("dict");
  });
});

describe("POST /import — limits (#12)", () => {
  async function importWith(repo: Repo, sizes: Record<string, number> = {}) {
    mockGitHub({ dict: repo }, sizes);
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv(ALICE, { dict: ["alice", null] }));
    const result = await importApp(session, "dict");
    return { ...result, saved: store.get("session") as any };
  }

  it("refuses a file over the per-file cap, naming it", async () => {
    const { status, body, saved } = await importWith(DICT, { "web/src/App.tsx": IMPORT_MAX_FILE_BYTES + 1 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/^web\/src\/App\.tsx is \d+ KB; files over 512 KB can't be imported\.$/);
    expect(saved.appId).toBeNull();
  });

  it("refuses a repo over the total size cap", async () => {
    const repo: Repo = { "a.ts": "a", "b.ts": "b" };
    const half = Math.ceil(IMPORT_MAX_TOTAL_BYTES / 2) + 1;
    const { status, body } = await importWith(repo, { "a.ts": half, "b.ts": half });
    expect(status).toBe(400);
    expect(body.error).toMatch(/KB of source; at most 750 KB can be imported/);
  });

  it("refuses a repo with too many source files", async () => {
    const repo: Repo = Object.fromEntries(Array.from({ length: IMPORT_MAX_FILES + 1 }, (_, i) => [`src/f${i}.ts`, "x"]));
    const { status, body } = await importWith(repo);
    expect(status).toBe(400);
    expect(body.error).toMatch(/has 201 source files; at most 200 can be imported/);
  });

  it("imports a repo exactly at the file-count cap", async () => {
    const repo: Repo = Object.fromEntries(Array.from({ length: IMPORT_MAX_FILES }, (_, i) => [`src/f${i}.ts`, "x"]));
    const { status, saved } = await importWith(repo);
    expect(status).toBe(200);
    expect(Object.keys(saved.files)).toHaveLength(IMPORT_MAX_FILES);
  });
});

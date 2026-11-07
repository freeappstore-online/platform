import { afterEach, describe, expect, it, vi } from "vitest";
import { listRepoFiles, pushFiles, type RepoFile, readRepoFile, textToB64 } from "./github.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ content: btoa("hi") }), { status: 200 });
  });
  return urls;
}

describe("repo URL guards", () => {
  it("reads a normal file from the app repo", async () => {
    const urls = stubFetch();
    expect(await readRepoFile("org", "timer", "t", "web/src/App.tsx")).toBe("hi");
    expect(urls).toEqual(["https://api.github.com/repos/org/timer/contents/web/src/App.tsx"]);
  });

  it.each(["../other-org/secrets", "..", "a/b", ""])("rejects repo %j without fetching", async (repo) => {
    const urls = stubFetch();
    await expect(readRepoFile("org", repo, "t", "README.md")).rejects.toThrow(/invalid repo/);
    await expect(listRepoFiles("org", repo, "t")).rejects.toThrow(/invalid repo/);
    expect(urls).toEqual([]);
  });

  it.each(["../../other/contents/x", "web/../../x", "./x", "a//b"])("rejects path %j without fetching", async (path) => {
    const urls = stubFetch();
    await expect(readRepoFile("org", "timer", "t", path)).rejects.toThrow(/invalid file path/);
    expect(urls).toEqual([]);
  });
});


/** A GitHub that records every call; `empty` makes the repo have no commits. */
function fakeGitHub(opts: { empty: boolean; refStatus?: number }) {
  const calls: { method: string; url: string; body?: any }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (url.endsWith("/git/ref/heads/main")) {
      return opts.empty ? json({ message: "Git Repository is empty." }, opts.refStatus ?? 409) : json({ object: { sha: "head" } });
    }
    if (method === "PUT" && url.includes("/contents/")) return json({ commit: { sha: "seed" } });
    if (url.includes("/git/commits/") && method === "GET") return json({ tree: { sha: "basetree" } });
    if (url.endsWith("/git/blobs")) return json({ sha: `blob-${calls.length}` });
    if (url.endsWith("/git/trees")) return json({ sha: "newtree" });
    if (url.endsWith("/git/commits")) return json({ sha: "newcommit" });
    if (url.endsWith("/git/refs/heads/main")) return json({ ref: "refs/heads/main" });
    return json({ message: "unexpected" }, 500);
  });
  return calls;
}

const file = (text: string): RepoFile => ({ content: textToB64(text), encoding: "base64" });

describe("pushFiles", () => {
  const files = new Map([
    [".github/workflows/deploy.yml", file("workflow")],
    ["fas.json", file("{}")],
    ["web/src/App.tsx", file("app")],
  ]);

  it("seeds an empty repo with a real file, never a .gitkeep, and keeps the workflow out of the first commit", async () => {
    const calls = fakeGitHub({ empty: true });
    expect(await pushFiles("org", "app", "t", files, "Initial")).toBe("newcommit");

    const seed = calls.find((c) => c.method === "PUT")!;
    expect(seed.url).toBe("https://api.github.com/repos/org/app/contents/fas.json");
    expect(seed.body.message).toBe("Initial");
    expect(calls.some((c) => c.url.includes(".gitkeep"))).toBe(false);

    const tree = calls.find((c) => c.url.endsWith("/git/trees"))!;
    expect(tree.body.base_tree).toBe("basetree");
    // The tree of the new app: the workflow and the remaining file, no placeholder.
    expect(tree.body.tree.map((t: { path: string }) => t.path).sort()).toEqual([".github/workflows/deploy.yml", "web/src/App.tsx"]);
    const commit = calls.find((c) => c.url.endsWith("/git/commits") && c.method === "POST")!;
    expect(commit.body.parents).toEqual(["seed"]);
  });

  it("adds one commit on top of an existing repo", async () => {
    const calls = fakeGitHub({ empty: false });
    await pushFiles("org", "app", "t", files, "Update");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    const commit = calls.find((c) => c.url.endsWith("/git/commits") && c.method === "POST")!;
    expect(commit.body.parents).toEqual(["head"]);
  });

  it("does not mistake a GitHub outage for an empty repo", async () => {
    const calls = fakeGitHub({ empty: true, refStatus: 500 });
    await expect(pushFiles("org", "app", "t", files, "x")).rejects.toThrow(/cannot read app main/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses to seed an empty repo with a workflow alone", async () => {
    fakeGitHub({ empty: true });
    await expect(pushFiles("org", "app", "t", new Map([[".github/workflows/deploy.yml", file("w")]]), "x")).rejects.toThrow(/non-workflow/);
  });
});

// #555: create_app scaffolds whatever the listing says is missing, so a GitHub
// failure read as "empty repo" would push the starter over an existing app.
describe("listRepoFiles", () => {
  function stub(ref: { status: number; body: unknown }, tree?: unknown) {
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/git/ref/heads/main")
        ? new Response(JSON.stringify(ref.body), { status: ref.status })
        : new Response(JSON.stringify(tree), { status: 200 }),
    );
  }

  it.each([404, 409])("lists a repo without main (%i) as empty", async (status) => {
    stub({ status, body: { message: "Not Found" } });
    expect(await listRepoFiles("org", "app", "t")).toEqual([]);
  });

  it("throws on a GitHub outage or rate limit instead of reporting an empty repo", async () => {
    stub({ status: 500, body: { message: "Server Error" } });
    await expect(listRepoFiles("org", "app", "t")).rejects.toThrow(/cannot read app main/);
    stub({ status: 403, body: { message: "API rate limit exceeded" } });
    await expect(listRepoFiles("org", "app", "t")).rejects.toThrow(/rate limit/);
  });

  it("throws when the tree is unreadable or truncated", async () => {
    stub({ status: 200, body: { object: { sha: "h" } } }, { message: "boom" });
    await expect(listRepoFiles("org", "app", "t")).rejects.toThrow(/cannot list app files/);
    stub({ status: 200, body: { object: { sha: "h" } } }, { tree: [], truncated: true });
    await expect(listRepoFiles("org", "app", "t")).rejects.toThrow(/too many files/);
  });

  it("lists blob paths", async () => {
    stub({ status: 200, body: { object: { sha: "h" } } }, { tree: [{ type: "blob", path: "a.ts" }, { type: "tree", path: "web" }] });
    expect(await listRepoFiles("org", "app", "t")).toEqual(["a.ts"]);
  });
});

describe("readRepoFile", () => {
  function stub(routes: Record<string, { status?: number; body: unknown }>) {
    vi.stubGlobal("fetch", async (url: string) => {
      const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
      return hit ? new Response(JSON.stringify(hit[1].body), { status: hit[1].status ?? 200 }) : new Response("{}", { status: 500 });
    });
  }

  it("returns null only when there is no such file", async () => {
    stub({ "/contents/a.ts": { status: 404, body: { message: "Not Found" } } });
    expect(await readRepoFile("org", "app", "t", "a.ts")).toBeNull();
    stub({ "/contents/web": { body: [{ name: "x", type: "file" }] } });
    expect(await readRepoFile("org", "app", "t", "web")).toBeNull();
  });

  it("throws on a GitHub failure instead of reporting the file missing", async () => {
    stub({ "/contents/a.ts": { status: 403, body: { message: "API rate limit exceeded" } } });
    await expect(readRepoFile("org", "app", "t", "a.ts")).rejects.toThrow(/rate limit/);
  });

  it("reads a file over 1 MB through the blob API", async () => {
    stub({
      "/contents/big.json": { body: { type: "file", encoding: "none", content: "", sha: "s1" } },
      "/git/blobs/s1": { body: { content: textToB64("big"), encoding: "base64" } },
    });
    expect(await readRepoFile("org", "app", "t", "big.json")).toBe("big");
  });
});

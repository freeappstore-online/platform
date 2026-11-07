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

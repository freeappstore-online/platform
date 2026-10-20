import { afterEach, describe, expect, it, vi } from "vitest";
import { listRepoFiles, readRepoFile } from "./github.js";

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

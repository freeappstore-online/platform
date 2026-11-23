import { afterEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../host";

const run = { id: "run", name: "Run", description: "Running tracker.", appUrl: "https://run.freeappstore.online" };
const route = { slug: "run", zone: "freeappstore.online", r2_prefix: "apps/run" } as Route;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A fresh module per test: the cache is module state. */
async function load() {
  vi.resetModules();
  return (await import("../seo")).publicApp;
}
afterEach(() => vi.unstubAllGlobals());

describe("publicApp", () => {
  it("gives each lookup made while another is in flight its own request (1101, #639)", async () => {
    const releases: ((r: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const publicApp = await load();
    const a = publicApp(route);
    const b = publicApp(route);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const release of releases) release(json({ apps: [run] }));
    expect(await Promise.all([a, b])).toEqual([run, run]);
  });

  it("serves a fresh cache without fetching and retries after a failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("no", { status: 503 })).mockResolvedValue(json({ apps: [run] }));
    vi.stubGlobal("fetch", fetchMock);
    const publicApp = await load();
    expect(await publicApp(route)).toBeUndefined();
    expect(await publicApp(route)).toEqual(run);
    expect(await publicApp(route)).toEqual(run);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

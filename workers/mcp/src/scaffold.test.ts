import { describe, expect, it } from "vitest";
import { b64ToText } from "./github.js";
import { type AppKind, buildScaffold, scaffoldRepo } from "./scaffold.js";

// The slug comes from the test input, never from the template token the
// implementation substitutes, so a renderer that leaves APPID behind cannot
// make these pass (#451).
const SLUG = "scoreplay-test";

function render(kind: AppKind) {
  const out = new Map<string, string>();
  for (const [path, file] of buildScaffold(SLUG, kind)) out.set(path, b64ToText(file.content));
  return out;
}

describe.each(["standalone", "connected"] as const)("MCP scaffold (%s)", (kind) => {
  const files = render(kind);
  const text = (path: string) => files.get(path)!;

  it("resolves every identity token: none left, no _JS/_TEXT artifacts", () => {
    for (const [path, content] of files) {
      expect(content, path).not.toMatch(/APPNAME|APPID/);
      expect(content, `${path} partial render`).not.toContain(`${SLUG}_JS`);
      expect(content, `${path} partial render`).not.toContain(`${SLUG}_TEXT`);
    }
  });

  it("emits the requested slug as the deployment and SDK identity", () => {
    expect(JSON.parse(text("fas.json")).appId).toBe(SLUG);
    expect(text("web/src/App.tsx")).toContain(`appId: "${SLUG}"`);
    const html = text("web/index.html");
    expect(html).toContain(`https://${SLUG}.freeappstore.online/`);
    expect(html).not.toContain("https://APPID");
  });

  it("emits a starter test that asserts the requested slug's SDK requests", () => {
    const starterTest = text("web/src/starter.test.ts");
    expect(starterTest).toContain(`/apps/${SLUG}/`);
    expect(starterTest).not.toContain("/apps/APPID/");
  });

  it("names the packages after the slug", () => {
    expect(JSON.parse(text("package.json")).name).toBe(SLUG);
    expect(JSON.parse(text("web/package.json")).name).toBe(`@${SLUG}/web`);
  });

  it("ships the current keyless workflow and no mirror maintenance or placeholder files", () => {
    const workflow = text(".github/workflows/deploy.yml");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toMatch(/secrets\.R2_/);
    expect([...files.keys()].some((path) => path.includes(".gitkeep") || path.startsWith(".fas-template/"))).toBe(false);
  });
});

it("the connected preset adds the connected draft", () => {
  expect(render("connected").has("web/src/components/ConnectedDraft.tsx")).toBe(true);
  expect(render("standalone").has("web/src/components/ConnectedDraft.tsx")).toBe(false);
});

describe("scaffoldRepo recovery (#549)", () => {
  it("a forced push failure is recoverable: calling again resumes with only the files the repo lacks", async () => {
    const repo = new Set<string>(); // what GitHub holds
    let failNext = true;
    const deps = {
      listFiles: async () => [...repo],
      push: async (files: Map<string, unknown>) => {
        if (failNext) {
          // The failure strikes after the empty repo's first commit landed.
          repo.add("fas.json");
          failNext = false;
          throw new Error("GitHub 502 while creating the tree");
        }
        for (const path of files.keys()) repo.add(path);
      },
    };

    await expect(scaffoldRepo(deps, SLUG, "standalone")).rejects.toThrow(/502/);
    expect([...repo]).toEqual(["fas.json"]); // workflow-less: the app could never deploy

    const resumed = await scaffoldRepo(deps, SLUG, "standalone");
    expect(resumed).toEqual({ status: "pushed", fileCount: buildScaffold(SLUG, "standalone").size - 1, resumed: true });
    expect(repo.has(".github/workflows/deploy.yml")).toBe(true);
    expect(repo.size).toBe(buildScaffold(SLUG, "standalone").size);
  });

  it("scaffolds an empty repo in full", async () => {
    const pushed: string[] = [];
    const result = await scaffoldRepo({ listFiles: async () => [], push: async (f) => void pushed.push(...f.keys()) }, SLUG, "connected");
    expect(result).toMatchObject({ status: "pushed", resumed: false });
    expect(pushed).toContain("web/src/components/ConnectedDraft.tsx");
  });

  it("never overwrites an app that already has its deploy workflow", async () => {
    const push = async () => {
      throw new Error("must not push");
    };
    expect(await scaffoldRepo({ listFiles: async () => [".github/workflows/deploy.yml", "fas.json"], push }, SLUG, "standalone")).toEqual({
      status: "already-scaffolded",
    });
  });
});

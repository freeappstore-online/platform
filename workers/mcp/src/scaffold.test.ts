import { describe, expect, it } from "vitest";
import { b64ToText } from "./github.js";
import { type AppKind, buildScaffold } from "./scaffold.js";

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

import { describe, expect, it } from "vitest";
import { createAppProblems, type FileChange, planScaffold, preflightUpdate, type RepoReader } from "./preflight.js";

const KEYLESS = "jobs:\n  build:\n    runs-on: x\n  deploy:\n    permissions:\n      id-token: write\n";

/** A healthy app: committed icon, vitest installed, aligned build target. */
const repoFiles: Record<string, string> = {
  "fas.json": JSON.stringify({ appId: "taskflow", applicationRoot: "web" }),
  "package.json": JSON.stringify({ name: "taskflow", scripts: { build: "pnpm --dir web build" } }),
  "web/package.json": JSON.stringify({ scripts: { build: "vite build", test: "vitest run" }, devDependencies: { vitest: "^4" } }),
  "web/index.html": '<link rel="icon" href="/icon.svg"><script type="module" src="/src/main.tsx"></script>',
  "web/src/main.tsx": "import './App'; initApp({appId: 'taskflow'});",
  "web/src/App.tsx": "export default () => null",
  "web/public/icon.svg": "<svg></svg>",
  ".github/workflows/deploy.yml": KEYLESS,
};

function repo(files = repoFiles): RepoReader {
  const encoder = new TextEncoder();
  return {
    paths: Object.keys(files),
    read: async (path) => files[path] ?? null,
    readBytes: async (path) => (path in files ? encoder.encode(files[path]) : null),
  };
}

const change = (path: string, content: string): FileChange => ({ path, content });
const run = (changes: FileChange[], files = repoFiles) => preflightUpdate("taskflow", changes, repo(files));

describe("update_files preflight", () => {
  it("accepts a normal source edit", async () => {
    expect(await run([change("web/src/App.tsx", "export default () => 1")])).toEqual([]);
  });

  it("checks the app after the push: a change that drops vitest is refused", async () => {
    const failures = await run([change("web/package.json", JSON.stringify({ scripts: { build: "vite build", test: "vitest run" } }))]);
    expect(failures.join("\n")).toMatch(/scripts\.test runs vitest/);
  });

  it("checks the app after the push: a manifest icon that is not in the repo is refused", async () => {
    const failures = await run([change("web/public/manifest.json", JSON.stringify({ icons: [{ src: "/pwa-512x512.png" }] }))]);
    expect(failures.join("\n")).toMatch(/icon \/pwa-512x512\.png/);
  });

  it("accepts an icon that the same push adds", async () => {
    const failures = await run([
      change("web/public/manifest.json", JSON.stringify({ icons: [{ src: "/new.png" }] })),
      change("web/public/new.png", "png-bytes"),
    ]);
    expect(failures).toEqual([]);
  });

  it("refuses a fas.json appId that is not this app", async () => {
    const failures = await run([change("fas.json", JSON.stringify({ appId: "other", applicationRoot: "web" }))]);
    expect(failures.join("\n")).toMatch(/fas\.json appId other differs from deployment ID taskflow/);
  });

  it("refuses to overwrite deploy.yml with a workflow that reads secrets.R2_ or has no deploy job", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    const legacy = "jobs:\n  upload:\n    env:\n      K: ${{ secrets.R2_ACCESS_KEY_ID }}\n";
    const failures = await run([change(".github/workflows/deploy.yml", legacy)]);
    expect(failures.join("\n")).toContain("secrets.R2_");
    expect(failures.join("\n")).toContain("no `deploy` job");
  });

  it("allows replacing deploy.yml with a keyless workflow", async () => {
    expect(await run([change(".github/workflows/deploy.yml", `${KEYLESS}# regenerated\n`)])).toEqual([]);
  });
});

describe("create_app preflight", () => {
  it("accepts a normal id and rejects malformed, prefixed and reserved ids", () => {
    expect(createAppProblems("dice-roller")).toEqual([]);
    expect(createAppProblems("Bad_Id").join()).toMatch(/2-31 characters/);
    expect(createAppProblems("freebie").join()).toMatch(/'free' or 'pro'/);
    expect(createAppProblems("platform").join()).toMatch(/reserved/);
  });

  it("resumes an empty or workflow-less repo and refuses to overwrite a scaffolded one", () => {
    expect(planScaffold([])).toEqual({ action: "scaffold", skip: new Set() });
    expect(planScaffold(["fas.json"])).toEqual({ action: "scaffold", skip: new Set(["fas.json"]) });
    expect(planScaffold([".github/workflows/deploy.yml", "fas.json"])).toEqual({ action: "already-scaffolded" });
  });
});

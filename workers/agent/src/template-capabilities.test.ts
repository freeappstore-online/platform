import { readFile } from "node:fs/promises";
import { minVersion, subset, validRange } from "semver";
import { expect, it } from "vitest";
import { checkCapabilityPackagePrerequisites, resolveCapabilities } from "../../../packages/cli/src/lib/capability-definitions";
import { getConfig } from "./config";
import { applyCapabilitiesToTemplate, getTemplateFiles } from "./template";

const semver = { validRange, minVersion, subset };

it("deploys the canonical starter generator when its platform source changes", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/deploy-agent.yml", import.meta.url), "utf8");
  expect(workflow).toContain("packages/cli/src/lib/starter-foundation.ts");
});

const pkg = (sdk?: string, pwa = false) =>
  JSON.stringify({
    dependencies: {
      ...(sdk ? { "@freeappstore/sdk": sdk } : {}),
      ...(pwa ? { "vite-plugin-pwa": "1.3.0" } : {}),
    },
  });

it.each([
  [undefined, "0.16.32", ["persistence"], false],
  ["0.16.32", "0.16.32", ["persistence"], true],
  ["0.16.39", undefined, ["pwa"], true],
  ["0.16.39", "0.16.39", ["persistence", "pwa"], true],
  ["0.16.32", "0.14.30", ["persistence", "pwa"], false],
  [undefined, undefined, ["persistence"], false],
])("resolves root %s and web %s for %s", async (root, web, ids, succeeds) => {
  const files: Record<string, string> = {
    ...(root === undefined ? {} : { "package.json": pkg(root, true) }),
    ...(web === undefined ? {} : { "web/package.json": pkg(web, true) }),
    "web/src/main.tsx": "// customized entry point",
  };
  const before = { ...files };
  const policy = checkCapabilityPackagePrerequisites(
    resolveCapabilities(ids),
    files["package.json"] ?? "{}",
    files["web/package.json"],
    semver,
  );
  expect(policy.errors.length === 0).toBe(succeeds);
  if (succeeds) {
    expect((await applyCapabilitiesToTemplate(files, ids, true)).files).toEqual(before);
    const result = await applyCapabilitiesToTemplate(files, ids);
    expect(result.files[".fas-capabilities.json"]).toBeDefined();
    expect(result.files["web/src/main.tsx"]).toBe(before["web/src/main.tsx"]);
    for (const cap of resolveCapabilities(ids)) for (const path of Object.keys(cap.files)) expect(result.files[path]).toBe(cap.files[path]);
    expect((await applyCapabilitiesToTemplate(result.files, ids)).files).toEqual(result.files);
  } else if (root === undefined) {
    await expect(applyCapabilitiesToTemplate(files, ids)).rejects.toThrow("missing package.json");
  } else {
    await expect(applyCapabilitiesToTemplate(files, ids)).rejects.toThrow("prerequisites unmet");
    const preview = await applyCapabilitiesToTemplate(files, ids, true);
    expect(preview.files).toBe(files);
    expect(preview.prerequisites.length).toBeGreaterThan(0);
  }
  expect(files).toEqual(before);
});

it.each(["standalone", "connected"] as const)(
  "prepares root SDK dependencies for fresh %s persistence and backup installs without mutating preview files",
  async (preset) => {
    const scaffold = getTemplateFiles(getConfig("apps"), "generic", preset);
    const customFiles = {
      ...scaffold,
      "web/src/App.tsx": "export const App = () => <main>Owner layout</main>;",
      "web/src/user-data.json": '{"keep":true}\n',
    };
    const before = { ...customFiles };
    const preview = await applyCapabilitiesToTemplate(customFiles, ["persistence", "backup"], true, false, true);

    expect(preview.files).toEqual(before);
    expect(preview.changes.join("\n")).toContain("UPDATE package.json");
    expect(preview.changes.join("\n")).toContain("CREATE fas-capabilities/persistence.ts");
    expect(preview.changes.join("\n")).toContain("CREATE fas-capabilities/backup.ts");
    expect(customFiles).toEqual(before);

    const applied = await applyCapabilitiesToTemplate(customFiles, ["persistence", "backup"], false, false, true);
    const rootPackage = JSON.parse(applied.files["package.json"]!);
    expect(rootPackage.dependencies["@freeappstore/sdk"]).toBe("^0.16.21");
    expect(rootPackage.packageManager).toBe(JSON.parse(scaffold["package.json"]!).packageManager);
    expect(rootPackage.scripts.typecheck).toBe(JSON.parse(scaffold["package.json"]!).scripts.typecheck);
    expect(applied.files["fas-capabilities/persistence.ts"]).toContain("@freeappstore/sdk/persist");
    expect(applied.files["fas-capabilities/backup.ts"]).toContain("@freeappstore/sdk/backup");
    expect(applied.files["web/src/App.tsx"]).toBe(before["web/src/App.tsx"]);
    expect(applied.files["web/src/user-data.json"]).toBe(before["web/src/user-data.json"]);
    expect(customFiles).toEqual(before);
  },
);

it.each([undefined, "^0.16.14"] as const)("keeps existing app root SDK prerequisite strict when root dependency is %s", async (rootSdk) => {
  const scaffold = getTemplateFiles(getConfig("apps"), "generic", "standalone");
  const existing = {
    ...scaffold,
    "package.json": JSON.stringify({ dependencies: rootSdk ? { "@freeappstore/sdk": rootSdk } : {} }),
    "web/package.json": JSON.stringify({ dependencies: { "@freeappstore/sdk": "^0.16.32" } }),
    "web/src/user-data.json": '{"keep":true}\n',
  };
  const before = { ...existing };
  const preview = await applyCapabilitiesToTemplate(existing, ["persistence", "backup"], true);
  expect(preview.prerequisites.join("\n")).toContain("package.json requires @freeappstore/sdk");
  expect(preview.files).toEqual(before);
  expect(existing).toEqual(before);
  await expect(applyCapabilitiesToTemplate(existing, ["persistence", "backup"])).rejects.toThrow("package prerequisites unmet");
  expect(existing).toEqual(before);
});

import { minVersion, subset, validRange } from "semver";
import { expect, it } from "vitest";
import { checkCapabilityPackagePrerequisites, resolveCapabilities } from "../../../packages/cli/src/lib/capability-definitions";
import { applyCapabilitiesToTemplate } from "./template";

const semver = { validRange, minVersion, subset };
const pkg = (sdk?: string, pwa = false) =>
  JSON.stringify({
    dependencies: {
      ...(sdk ? { "@freeappstore/sdk": sdk } : {}),
      ...(pwa ? { "vite-plugin-pwa": "1.3.0" } : {}),
    },
  });

it.each([
  [undefined, "0.16.26", ["persistence"], false],
  ["0.16.26", "0.14.30", ["persistence"], true],
  ["0.16.26", undefined, ["pwa"], true],
  ["0.16.26", "0.16.26", ["persistence", "pwa"], true],
  ["0.16.26", "0.14.30", ["persistence", "pwa"], false],
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

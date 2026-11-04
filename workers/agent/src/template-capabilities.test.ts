import { expect, it } from "vitest";
import { applyCapabilitiesToTemplate } from "./template";
import { checkCapabilityPackagePrerequisites, resolveCapabilities } from "../../../packages/cli/src/lib/capability-definitions";
const pkg = (sdk?: string, pwa = false) => JSON.stringify({ dependencies: {
  ...(sdk ? { "@freeappstore/sdk": sdk } : {}), ...(pwa ? { "vite-plugin-pwa": "1.3.0" } : {}),
} });
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
  const policy = checkCapabilityPackagePrerequisites(resolveCapabilities(ids),
    JSON.parse(files["package.json"] ?? "{}"), web === undefined ? undefined : JSON.parse(files["web/package.json"]));
  expect(policy.prerequisites.length === 0).toBe(succeeds);
  if (succeeds) {
    expect(await applyCapabilitiesToTemplate(files, ids, { dryRun: true })).toEqual(before);
    const result = await applyCapabilitiesToTemplate(files, ids);
    expect(result[".fas-capabilities.json"]).toBeDefined();
    expect(result["web/src/main.tsx"]).toBe(before["web/src/main.tsx"]);
    for (const cap of resolveCapabilities(ids)) for (const path of Object.keys(cap.files)) expect(result[path]).toBe(cap.files[path]);
    expect(await applyCapabilitiesToTemplate(result, ids)).toEqual(result);
  } else {
    await expect(applyCapabilitiesToTemplate(files, ids)).rejects.toThrow("no files or manifest written");
    await expect(applyCapabilitiesToTemplate(files, ids, { dryRun: true })).rejects.toThrow("prerequisites");
  }
  expect(files).toEqual(before);
});

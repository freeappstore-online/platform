// Run the shared pure policy in workerd: semver must bundle without Node APIs.
import { expect, it } from "vitest";
import { minVersion, subset, validRange } from "semver";
import { checkCapabilityPackagePrerequisites, resolveCapabilities, satisfiesCapabilityPackageRange } from "../../../../packages/cli/src/lib/capability-definitions";

const semver = { validRange, minVersion, subset };

it.each([
  ["0.16.26-beta.1", ">=0.16.26", false],
  ["^0.16.26-beta.1", ">=0.16.26", false],
  [">=0.16.26 <0.17.0", ">=0.16.26", true],
  [">= 0.16.26 < 0.17.0", ">=0.16.26", true],
  ["1.3.x", "^1.0.0", true],
  ["0.16.26+build.1", ">=0.16.26", true],
  ["0.16.26 - 0.16.30", ">=0.16.26", true],
  ["^0.16.26", ">=0.16.26", true],
])("checks bundled prerequisite %s against %s", (declared, required, expected) => {
  expect(satisfiesCapabilityPackageRange(declared, required, semver)).toBe(expected);
});

it.each([
  [undefined, "0.16.26", "persistence", false],
  ["0.16.26", "0.14.30", "persistence", true],
  ["0.16.39", undefined, "pwa", true],
])("checks bundled package locations %s / %s for %s", (root, web, id, accepted) => {
  const pkg = (sdk?: string) => JSON.stringify({ dependencies: {
    ...(sdk ? { "@freeappstore/sdk": sdk } : {}), "vite-plugin-pwa": "1.3.0",
  } });
  const result = checkCapabilityPackagePrerequisites(
    resolveCapabilities([id]),
    pkg(root),
    web === undefined ? undefined : pkg(web),
    semver,
  );
  expect(result.errors.length === 0).toBe(accepted);
});

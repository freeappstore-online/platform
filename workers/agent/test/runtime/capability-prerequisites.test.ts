// Run the shared pure policy in workerd: semver must bundle without Node APIs.
import { expect, it } from "vitest";
import { satisfiesCapabilityPackageRange } from "../../../../packages/cli/src/lib/capability-definitions";

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
  expect(satisfiesCapabilityPackageRange(declared, required)).toBe(expected);
});

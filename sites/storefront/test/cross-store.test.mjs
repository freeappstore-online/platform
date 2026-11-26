/** Homepage cross-store search: which FreeGameStore registry it reads and which games it lists (#751). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CROSS_STORE_REGISTRY_PATH, crossStoreItems } = require("../lib/cross-store.cjs");

test("reads the FGS platform monorepo registry, not the archived freegamestore repo", () => {
  assert.equal(CROSS_STORE_REGISTRY_PATH, "/freegamestore-online/platform/main/sites/freegamestore/registry.json");
  const build = readFileSync(new URL("../build.js", import.meta.url), "utf8");
  assert.ok(!build.includes("/freegamestore-online/freegamestore/main/registry.json"));
});

test("drops pending and failed games, keeps live and status-less entries", () => {
  const items = crossStoreItems({
    games: [
      { id: "old" },
      { id: "live", status: "live" },
      { id: "pending", status: "pending" },
      { id: "failed", status: "failed" },
    ],
  });
  assert.deepEqual(items.map((g) => g.id), ["old", "live"]);
  assert.deepEqual(crossStoreItems({}), []);
});

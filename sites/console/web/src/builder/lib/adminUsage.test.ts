import { describe, expect, it } from "vitest";
import { type AppUsage, sortUsage, trendPercent } from "./adminUsage";

const pts = (...views: number[]) => views.map((v, i) => ({ t: `2026-10-${String(10 + i).padStart(2, "0")}`, views: v }));

function usage(id: string, owner: string, views: number, series = pts(0, 0)): AppUsage {
  return { id, owner, views, unique_paths: 0, series, no_views: views === 0 };
}

describe("trendPercent", () => {
  it("compares the second half of the window with the first", () => {
    expect(trendPercent(pts(1, 1, 2, 2))).toBe(100);
    expect(trendPercent(pts(4, 4, 1, 1))).toBe(-75);
  });

  it("returns null with no baseline", () => {
    expect(trendPercent(pts(0, 0, 3, 3))).toBeNull();
    expect(trendPercent(pts(5))).toBeNull();
  });
});

describe("sortUsage", () => {
  const apps = [usage("bravo", "bob", 3, pts(1, 2)), usage("alpha", "zed", 12, pts(4, 1)), usage("quiet", "amy", 0)];

  it("sorts by views, descending and ascending", () => {
    expect(sortUsage(apps, "views", "desc").map((a) => a.id)).toEqual(["alpha", "bravo", "quiet"]);
    expect(sortUsage(apps, "views", "asc").map((a) => a.id)).toEqual(["quiet", "bravo", "alpha"]);
  });

  it("sorts by text columns", () => {
    expect(sortUsage(apps, "owner", "asc").map((a) => a.owner)).toEqual(["amy", "bob", "zed"]);
  });

  it("puts apps without a trend baseline last when sorting by trend descending", () => {
    expect(sortUsage(apps, "trend", "desc").map((a) => a.id)).toEqual(["bravo", "alpha", "quiet"]);
  });

  it("does not mutate the input", () => {
    sortUsage(apps, "id", "asc");
    expect(apps.map((a) => a.id)).toEqual(["bravo", "alpha", "quiet"]);
  });
});

// Cross-app usage report for the admin dashboard (#271). Mirrors the shape of
// GET /v1/analytics/admin/apps; the helpers here keep sorting and trend maths
// out of the component so they can be tested.

export interface UsagePoint {
  t: string;
  views: number;
}

export interface AppUsage {
  id: string;
  owner: string;
  views: number;
  unique_paths: number;
  series: UsagePoint[];
  no_views: boolean;
}

export interface UsageReport {
  days: number;
  totals: {
    views: number;
    apps: number;
    apps_with_views: number;
    apps_without_views: number;
    series: UsagePoint[];
  };
  apps: AppUsage[];
  unregistered: Array<{ id: string; views: number }>;
}

export type UsageSortKey = "id" | "owner" | "views" | "unique_paths" | "trend";
export type SortDir = "asc" | "desc";

/**
 * Change between the first and second half of a series, as a percentage of
 * the first half. Null when the first half had no views (no baseline).
 */
export function trendPercent(series: UsagePoint[]): number | null {
  if (series.length < 2) return null;
  const mid = Math.floor(series.length / 2);
  const sum = (points: UsagePoint[]) => points.reduce((total, p) => total + p.views, 0);
  const before = sum(series.slice(0, mid));
  const after = sum(series.slice(series.length - mid));
  if (before === 0) return null;
  return Math.round(((after - before) / before) * 100);
}

export function sortUsage(apps: AppUsage[], key: UsageSortKey, dir: SortDir): AppUsage[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (app: AppUsage): number | string => {
    if (key === "id") return app.id;
    if (key === "owner") return app.owner;
    if (key === "trend") return trendPercent(app.series) ?? Number.NEGATIVE_INFINITY;
    return app[key];
  };
  return [...apps].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const cmp = typeof va === "string" || typeof vb === "string" ? String(va).localeCompare(String(vb)) : va - vb;
    return cmp * sign || a.id.localeCompare(b.id);
  });
}

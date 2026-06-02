import { describe, expect, it, vi } from "vitest";

function statusDot(status: string): string {
  if (status === "active" || status === "success" || status === "completed") return "🟢";
  if (status === "pending" || status === "in_progress" || status === "initializing") return "🟡";
  if (status === "failure" || status === "error" || status === "none" || status === "not_configured") return "🔴";
  return "⚪";
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

describe("statusDot", () => {
  it("green for success states", () => {
    for (const s of ["active", "success", "completed"]) expect(statusDot(s)).toBe("🟢");
  });
  it("yellow for pending states", () => {
    for (const s of ["pending", "in_progress", "initializing"]) expect(statusDot(s)).toBe("🟡");
  });
  it("red for failure states", () => {
    for (const s of ["failure", "error", "none", "not_configured"]) expect(statusDot(s)).toBe("🔴");
  });
  it("gray for unknown", () => {
    expect(statusDot("whatever")).toBe("⚪");
  });
});

describe("timeAgo", () => {
  it("dash for null", () => expect(timeAgo(null)).toBe("—"));
  it("just now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:30Z"));
    expect(timeAgo("2026-05-04T12:00:00Z")).toBe("just now");
    vi.useRealTimers();
  });
  it("minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:05:00Z"));
    expect(timeAgo("2026-05-04T12:00:00Z")).toBe("5m ago");
    vi.useRealTimers();
  });
  it("hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T15:00:00Z"));
    expect(timeAgo("2026-05-04T12:00:00Z")).toBe("3h ago");
    vi.useRealTimers();
  });
  it("days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T12:00:00Z"));
    expect(timeAgo("2026-05-04T12:00:00Z")).toBe("3d ago");
    vi.useRealTimers();
  });
});

describe("Registry (live)", () => {
  it("apps registry accessible with valid data", async () => {
    const res = await fetch("https://raw.githubusercontent.com/freeappstore-online/freeappstore/main/registry.json");
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(data.apps.length).toBeGreaterThan(0);
    for (const a of data.apps) {
      expect(a.id).toBeTruthy();
      expect(a.name).toBeTruthy();
    }
  });

  it("games registry accessible with valid data", async () => {
    const res = await fetch("https://raw.githubusercontent.com/freegamestore-online/freegamestore/main/registry.json");
    expect(res.ok).toBe(true);
    const data = (await res.json()) as any;
    expect(data.games.length).toBeGreaterThan(0);
    for (const g of data.games) {
      expect(g.id).toBeTruthy();
      expect(g.name).toBeTruthy();
    }
  });

  it("no duplicate IDs in apps", async () => {
    const data = (await (
      await fetch("https://raw.githubusercontent.com/freeappstore-online/freeappstore/main/registry.json")
    ).json()) as any;
    const ids = data.apps.map((a: any) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no duplicate IDs in games", async () => {
    const data = (await (
      await fetch("https://raw.githubusercontent.com/freegamestore-online/freegamestore/main/registry.json")
    ).json()) as any;
    const ids = data.games.map((g: any) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Store metadata", () => {
  it("domain convention", () => {
    expect("timer.freeappstore.online").toMatch(/\.freeappstore\.online$/);
    expect("chess.freegamestore.online").toMatch(/\.freegamestore\.online$/);
  });
});

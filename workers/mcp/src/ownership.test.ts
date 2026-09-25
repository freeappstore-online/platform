import { afterEach, describe, expect, it, vi } from "vitest";
import { ownershipGateText, ownsApp } from "./ownership";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ownsApp", () => {
  it("returns owned=true when the app is in /v1/apps/mine", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ apps: [{ id: "calendar" }] }))));

    await expect(ownsApp("https://api.example", "token", "calendar")).resolves.toEqual({ owned: true });
  });

  it("returns owned=false only for a confirmed non-owned app", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ apps: [{ id: "notes" }] }))));

    await expect(ownsApp("https://api.example", "token", "calendar")).resolves.toEqual({ owned: false });
  });

  it("propagates 401 instead of returning false ownership", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));

    const result = await ownsApp("https://api.example", "token", "calendar");

    expect(result).toEqual({ error: "Unauthorized", status: 401 });
    expect(ownershipGateText("calendar", result)).toBe("Ownership check failed (401): Unauthorized");
  });

  it("propagates 500 instead of returning false ownership", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("backend failure", { status: 500 })));

    const result = await ownsApp("https://api.example", "token", "calendar");

    expect(result).toEqual({ error: "backend failure", status: 500 });
    expect(ownershipGateText("calendar", result)).toBe("Ownership check failed (500): backend failure");
  });

  it("propagates network errors instead of returning false ownership", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    const result = await ownsApp("https://api.example", "token", "calendar");

    expect(result).toEqual({ error: "Ownership check request failed: network unavailable", status: 503 });
    expect(ownershipGateText("calendar", result)).toBe("Ownership check failed (503): Ownership check request failed: network unavailable");
  });

  it("keeps non-ownership as a non-error caller response", () => {
    expect(ownershipGateText("calendar", { owned: false })).toBe(
      'You don\'t own "calendar" (or it isn\'t published). Only the owner can update it.',
    );
  });
});

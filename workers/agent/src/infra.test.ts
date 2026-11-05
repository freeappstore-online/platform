import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "./config";
import { checkDeployStatus, fetchUrl, getAuditResults, getBuildLogs } from "./infra";

const config = getConfig("apps");
const env = { GITHUB_TOKEN: "ghp_test" };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("checkDeployStatus", () => {
  it("returns workflow run info", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          workflow_runs: [{ status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", name: "Deploy" }],
        }),
    }) as any;
    const result = await checkDeployStatus("timer", env, config);
    expect(result).toContain("success");
    expect(result).toContain("timer.freeappstore.online");
    expect(result).toContain("Deploy");
  });

  it("handles no runs", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ workflow_runs: [] }),
    }) as any;
    const result = await checkDeployStatus("timer", env, config);
    expect(result).toContain("No workflow runs");
  });
});

describe("getBuildLogs", () => {
  it("returns job and step details", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          json: () => Promise.resolve({ workflow_runs: [{ id: 123, status: "completed", conclusion: "success", name: "Deploy" }] }),
        });
      }
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            jobs: [
              {
                name: "build",
                status: "completed",
                conclusion: "success",
                steps: [{ name: "Checkout", status: "completed", conclusion: "success" }],
              },
            ],
          }),
      });
    }) as any;
    const result = await getBuildLogs("timer", env, config);
    expect(result).toContain("Job: build");
    expect(result).toContain("Checkout");
  });
});

describe("fetchUrl", () => {
  it("returns status and body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve("<html>hello</html>"),
      headers: new Headers(),
    }) as any;
    const result = await fetchUrl("https://example.com", "GET", "test");
    expect(result).toContain("200 OK");
    expect(result).toContain("hello");
  });

  it("reports redirects without following", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 301, headers: new Headers({ Location: "https://other.com" }) }) as any;
    const result = await fetchUrl("https://example.com", "GET", "test");
    expect(result).toContain("301 Redirect");
    expect(result).toContain("https://other.com");
  });

  it("handles fetch errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS failed")) as any;
    const result = await fetchUrl("https://bad.invalid", "GET", "test");
    expect(result).toContain("Fetch error");
    expect(result).toContain("DNS failed");
  });
});

describe("getAuditResults", () => {
  it("formats audit summary", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          summary: [{ appId: "timer", store: "apps", pass: 5, warn: 1, fail: 0, checkedAt: 1 }],
          checks: [
            { appId: "timer", store: "apps", checkName: "License", status: "pass", detail: null, checkedAt: 1 },
            { appId: "timer", store: "apps", checkName: "Bundle size", status: "warn", detail: "big", checkedAt: 1 },
          ],
          total: 6,
        }),
    }) as any;
    const result = await getAuditResults("timer", config);
    expect(result).toContain("Audit for timer: 5 pass, 1 warn, 0 fail");
    expect(result).toContain("PASS: License");
    expect(result).toContain("WARN: Bundle size — big");
    expect(result).toContain("showing 2 of 6 checks");
    expect(result).not.toContain("undefined");
  });

  it("falls back to raw JSON when the app has no audit rows", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ summary: [], checks: [], total: 0 }),
    }) as any;
    const result = await getAuditResults("timer", config);
    expect(result).toContain('"total": 0');
  });

  it("handles API errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    const result = await getAuditResults("timer", config);
    expect(result).toContain("500");
  });

  it("queries the FAS audit API with the store filter for both stores", async () => {
    // Games have no api.freegamestore.online — that host is the FGS host
    // worker and 404s "no game registered". Both stores' audit rows live
    // in the FAS backend (#450).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          summary: [{ appId: "chess", store: "games", pass: 5, warn: 0, fail: 0, checkedAt: 1 }],
          checks: [],
          total: 0,
        }),
    });
    globalThis.fetch = fetchMock as any;

    const result = await getAuditResults("chess", getConfig("games"));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.freeappstore.online/v1/audit?store=games&app=chess");
    expect(result).toContain("Audit for chess: 5 pass, 0 warn, 0 fail");

    await getAuditResults("timer", config);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.freeappstore.online/v1/audit?store=apps&app=timer");
  });
});

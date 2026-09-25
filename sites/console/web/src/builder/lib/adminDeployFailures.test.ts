import { describe, expect, it } from "vitest";
import {
  type AdminFailingDeployApp,
  type AdminFailingDeploySession,
  type AdminGithubDeployStatus,
  buildFailingDeployRows,
  deployStatusForApp,
} from "./adminDeployFailures";

const app = (over: Partial<AdminFailingDeployApp> = {}): AdminFailingDeployApp => ({
  id: "demo",
  name: "Demo",
  owner: "octocat",
  domain: "demo.freeappstore.online",
  ...over,
});

const status = (over: Partial<AdminGithubDeployStatus> = {}): AdminGithubDeployStatus => ({
  status: "completed",
  conclusion: "failure",
  at: "2026-09-25T00:00:00Z",
  sha: "abc1234",
  url: "https://github.com/freeappstore-online/demo/actions/runs/42",
  branch: "main",
  ...over,
});

const session = (over: Partial<AdminFailingDeploySession> = {}): AdminFailingDeploySession => ({
  sessionId: "sess_1",
  userId: "user_1",
  userLogin: "builder",
  name: "Build demo",
  appId: "demo",
  deployState: { phase: "error", error: "npm run build failed because src/App.tsx has a type error" },
  deployLog: [],
  updatedAt: 1_790_294_400_000,
  ...over,
});

describe("buildFailingDeployRows", () => {
  it("combines GH Actions failures and VibeCode session failures", () => {
    const rows = buildFailingDeployRows({
      apps: [app(), app({ id: "session-only", name: "Session Only", owner: "owner2", domain: "session-only.freeappstore.online" })],
      statuses: { demo: status() },
      sessions: [session(), session({ sessionId: "sess_2", appId: "session-only" })],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.appId)).toEqual(["demo", "session-only"]);
    expect(rows[0]).toMatchObject({
      source: "github",
      ownerLogin: "octocat",
      actionsUrl: "https://github.com/freeappstore-online/demo/actions/runs/42",
    });
    expect(rows[1]).toMatchObject({
      source: "session",
      ownerLogin: "owner2",
      actionsUrl: "https://github.com/freeappstore-online/session-only/actions",
    });
  });

  it("de-duplicates by app ID and prefers GH run data with session error detail", () => {
    const rows = buildFailingDeployRows({
      apps: [app()],
      statuses: { demo: status({ url: "https://github.com/freeappstore-online/demo/actions/runs/99" }) },
      sessions: [session({ deployState: { phase: "error", error: "Cloudflare Pages build failed at the install step" } })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "github:demo",
      source: "github",
      errorSummary: "Cloudflare Pages build failed at the install step",
      actionsUrl: "https://github.com/freeappstore-online/demo/actions/runs/99",
      sessionId: "sess_1",
    });
  });

  it("keeps error summaries to the first 120 characters", () => {
    const longError = "x".repeat(150);
    const rows = buildFailingDeployRows({
      apps: [app()],
      statuses: {},
      sessions: [session({ deployState: { phase: "error", error: longError } })],
    });

    expect(rows[0]?.errorSummary).toHaveLength(120);
  });

  it("ignores non-failing GH statuses and non-error sessions", () => {
    const rows = buildFailingDeployRows({
      apps: [app()],
      statuses: { demo: status({ conclusion: "success" }) },
      sessions: [session({ deployState: { phase: "live" } })],
    });

    expect(rows).toEqual([]);
  });
});

describe("deployStatusForApp", () => {
  it("uses GH Actions conclusion before the latest VibeCode session phase", () => {
    expect(
      deployStatusForApp(app({ latestSession: { deployed: true, deployState: { phase: "live" } } }), {
        demo: status(),
      }),
    ).toBe("failure");
  });

  it("falls back to the latest session phase when GH status is unavailable", () => {
    expect(deployStatusForApp(app({ latestSession: { deployed: false, deployState: { phase: "building" } } }), {})).toBe("building");
  });
});

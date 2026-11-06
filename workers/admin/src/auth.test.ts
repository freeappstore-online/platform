import { describe, expect, it } from "vitest";
import { authenticateApiRequest, isCiTestReport, timingSafeEqual } from "./auth";
import type { Env } from "./helpers";

describe("shared-secret checks", () => {
  it("timingSafeEqual matches only identical strings", () => {
    expect(timingSafeEqual("s3cret", "s3cret")).toBe(true);
    expect(timingSafeEqual("s3cret", "s3creX")).toBe(false);
    expect(timingSafeEqual("s3cret", "s3cre")).toBe(false);
  });

  it("accepts the internal token and rejects a wrong one", async () => {
    const env = { ADMIN_PROVISION_TOKEN: "tok" } as unknown as Env;
    const req = (t: string) => new Request("https://admin/api/provision", { headers: { "X-Internal-Token": t } });
    expect(await authenticateApiRequest(req("tok"), env)).toEqual({ ok: true, kind: "service" });
    expect(await authenticateApiRequest(req("tox"), env)).toMatchObject({ ok: false, status: 401 });
  });

  describe("session callers (#495)", () => {
    const envFor = (me: Record<string, unknown>) =>
      ({
        ADMIN_PROVISION_TOKEN: "tok",
        BACKEND_FAS: { fetch: async () => Response.json(me) },
      }) as unknown as Env;
    const req = new Request("https://admin/api/apps", { headers: { Authorization: "Bearer t" } });
    const admin = { id: "gh:1", login: "ops", githubLogin: "ops", roles: ["user", "admin"] };

    it("accepts an admin on a console session", async () => {
      expect(await authenticateApiRequest(req, envFor({ ...admin, aud: "console" }))).toMatchObject({ ok: true, kind: "admin" });
    });

    it.each([
      ["an app-scoped session", { ...admin, aud: "chess" }],
      ["a pre-#495 session with no audience", admin],
    ])("refuses an admin on %s with 401", async (_label, me) => {
      expect(await authenticateApiRequest(req, envFor(me))).toMatchObject({ ok: false, status: 401 });
    });

    it("still refuses a non-admin console session with 403", async () => {
      expect(await authenticateApiRequest(req, envFor({ ...admin, roles: ["user"], aud: "console" }))).toMatchObject({
        ok: false,
        status: 403,
      });
    });
  });

  it("lets the CI report through only with the CI token", () => {
    const env = { CI_TOKEN: "ci" } as unknown as Env;
    const url = new URL("https://admin/api/test-report");
    const req = (t?: string) => new Request(url, { method: "PUT", headers: t ? { "X-CI-Token": t } : {} });
    expect(isCiTestReport(req("ci"), url, env)).toBe(true);
    expect(isCiTestReport(req("cx"), url, env)).toBe(false);
    expect(isCiTestReport(req(), url, env)).toBe(false);
  });
});

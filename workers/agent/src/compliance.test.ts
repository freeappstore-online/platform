import { describe, expect, it } from "vitest";
import { runComplianceCheck } from "./compliance";
import { getConfig } from "./config";

const appsConfig = getConfig("apps");
const gamesConfig = getConfig("games");

function makeFiles(overrides: Record<string, string> = {}): Map<string, string> {
  return new Map(
    Object.entries({
      LICENSE: "MIT License\nCopyright...",
      "package.json": '{"packageManager":"pnpm@10"}',
      "pnpm-workspace.yaml": "packages:\n  - web",
      "web/index.html":
        '<html lang="en"><head><meta name="viewport"><meta name="apple-mobile-web-app-capable" content="yes"><title>App</title></head></html>',
      "web/src/index.css":
        "@import url(manrope); @import url(fraunces); :root { --paper: #fff; --ink: #000; --accent: blue; } @media (prefers-color-scheme: dark) {}",
      "web/src/App.tsx": 'import "./index.css"; export default () => <a href="https://freeappstore.online">Store</a>',
      "web/public/manifest.json": '{"name":"App","display":"standalone","start_url":"/"}',
      ...overrides,
    }),
  );
}

describe("runComplianceCheck", () => {
  it("all pass with complete files", () => {
    const output = runComplianceCheck(makeFiles(), appsConfig);
    expect(output).not.toContain("FAIL");
    expect(output).toContain("PASS: MIT License");
    expect(output).toContain("PASS: Dark mode support");
  });

  it("fails on missing LICENSE", () => {
    const files = makeFiles();
    files.delete("LICENSE");
    expect(runComplianceCheck(files, appsConfig)).toContain("FAIL: MIT License");
  });

  it("fails on .env.production", () => {
    const output = runComplianceCheck(makeFiles({ ".env.production": "SECRET=x" }), appsConfig);
    expect(output).toContain("FAIL: No .env.production");
  });

  it("fails on tracking SDK", () => {
    const output = runComplianceCheck(makeFiles({ "web/src/track.ts": "import amplitude from 'amplitude'" }), appsConfig);
    expect(output).toContain("FAIL: No tracking SDKs");
  });

  it("fails on missing brand fonts", () => {
    const output = runComplianceCheck(
      makeFiles({ "web/src/index.css": ":root { --paper: #fff; --ink: #000; --accent: blue; }" }),
      appsConfig,
    );
    expect(output).toContain("FAIL: Brand fonts");
  });

  it("checks overflow hidden for games", () => {
    const output = runComplianceCheck(
      makeFiles({
        "web/src/index.css":
          "@import url(manrope); @import url(fraunces); :root { --paper: #000; --ink: #fff; --accent: red; } body { overflow: hidden; }",
      }),
      gamesConfig,
    );
    expect(output).toContain("PASS: Overflow hidden");
    expect(output).toContain("PASS: CSS variables (--paper, --ink, --accent)");
  });

  it("detects APPNAME placeholder", () => {
    const output = runComplianceCheck(makeFiles({ "web/src/App.tsx": "const name = 'APPNAME'" }), appsConfig);
    expect(output).toContain("FAIL: APPNAME placeholders");
  });

  describe("store link and the SDK Shell (#90)", () => {
    const shellApp = 'import { Shell } from "@freeappstore/sdk/ui";\nexport default () => <Shell app={fas} nav={NAV}>hi</Shell>';

    it("an app wrapped in the SDK Shell passes: the Shell topbar links to the store", () => {
      const output = runComplianceCheck(makeFiles({ "web/src/App.tsx": shellApp }), appsConfig);
      expect(output).toContain("PASS: FreeAppStore link (SDK Shell topbar)");
      expect(output).not.toContain("FAIL");
    });

    it("the FasShell alias counts too", () => {
      const app = 'import { FasShell } from "@freeappstore/sdk/ui";\nexport default () => <FasShell app={fas}>hi</FasShell>';
      expect(runComplianceCheck(makeFiles({ "web/src/App.tsx": app }), appsConfig)).not.toContain("FAIL");
    });

    it("importing the SDK UI without rendering Shell still needs a link", () => {
      const app = 'import { Card } from "@freeappstore/sdk/ui";\nexport default () => <Card>hi</Card>';
      expect(runComplianceCheck(makeFiles({ "web/src/App.tsx": app }), appsConfig)).toContain("FAIL: FreeAppStore link");
    });

    it("a local component named Shell does not count", () => {
      const app = 'import { Shell } from "./components/Shell";\nexport default () => <Shell>hi</Shell>';
      expect(runComplianceCheck(makeFiles({ "web/src/App.tsx": app }), appsConfig)).toContain("FAIL: FreeAppStore link");
    });
  });
});

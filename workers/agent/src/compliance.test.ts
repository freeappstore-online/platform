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
  it("all pass with complete files", async () => {
    const output = await runComplianceCheck(makeFiles(), appsConfig);
    expect(output).not.toContain("FAIL");
    expect(output).toContain("PASS: MIT License");
    expect(output).toContain("PASS: Dark mode support");
  });

  it("fails on missing LICENSE", async () => {
    const files = makeFiles();
    files.delete("LICENSE");
    expect(await runComplianceCheck(files, appsConfig)).toContain("FAIL: MIT License");
  });

  it("fails on .env.production", async () => {
    const output = await runComplianceCheck(makeFiles({ ".env.production": "SECRET=x" }), appsConfig);
    expect(output).toContain("FAIL: No .env.production");
  });

  it("fails on tracking SDK", async () => {
    const output = await runComplianceCheck(makeFiles({ "web/src/track.ts": "import amplitude from 'amplitude'" }), appsConfig);
    expect(output).toContain("FAIL: No tracking SDKs");
  });

  it("fails on missing brand fonts", async () => {
    const output = await runComplianceCheck(
      makeFiles({ "web/src/index.css": ":root { --paper: #fff; --ink: #000; --accent: blue; }" }),
      appsConfig,
    );
    expect(output).toContain("FAIL: Brand fonts");
  });

  it("checks overflow hidden for games", async () => {
    const output = await runComplianceCheck(
      makeFiles({
        "web/src/index.css":
          "@import url(manrope); @import url(fraunces); :root { --paper: #000; --ink: #fff; --accent: red; } body { overflow: hidden; }",
      }),
      gamesConfig,
    );
    expect(output).toContain("PASS: Overflow hidden");
    expect(output).toContain("PASS: CSS variables (--paper, --ink, --accent)");
  });

  it("detects APPNAME placeholder", async () => {
    const output = await runComplianceCheck(makeFiles({ "web/src/App.tsx": "const name = 'APPNAME'" }), appsConfig);
    expect(output).toContain("FAIL: APPNAME placeholders");
  });

  describe("store link and the SDK Shell (#90)", () => {
    const shellApp = 'import { Shell } from "@freeappstore/sdk/ui";\nexport default () => <Shell app={fas} nav={NAV}>hi</Shell>';

    it("an app wrapped in the SDK Shell passes: the Shell topbar links to the store", async () => {
      const output = await runComplianceCheck(makeFiles({ "web/src/App.tsx": shellApp }), appsConfig);
      expect(output).toContain("PASS: FreeAppStore link (SDK Shell topbar)");
      expect(output).not.toContain("FAIL");
    });

    it("the FasShell alias counts too", async () => {
      const app = 'import { FasShell } from "@freeappstore/sdk/ui";\nexport default () => <FasShell app={fas}>hi</FasShell>';
      expect(await runComplianceCheck(makeFiles({ "web/src/App.tsx": app }), appsConfig)).not.toContain("FAIL");
    });

    it("importing the SDK UI without rendering Shell still needs a link", async () => {
      const app = 'import { Card } from "@freeappstore/sdk/ui";\nexport default () => <Card>hi</Card>';
      expect(await runComplianceCheck(makeFiles({ "web/src/App.tsx": app }), appsConfig)).toContain("FAIL: FreeAppStore link");
    });

    it("a local component named Shell does not count", async () => {
      const app = 'import { Shell } from "./components/Shell";\nexport default () => <Shell>hi</Shell>';
      expect(await runComplianceCheck(makeFiles({ "web/src/App.tsx": app }), appsConfig)).toContain("FAIL: FreeAppStore link");
    });
  });

  // The shared @freeappstore/compliance checks, the same ones fas check and app CI run.
  describe("no payments and no ads", () => {
    const stripeApp =
      'import { loadStripe } from "@stripe/stripe-js";\nconst stripe = loadStripe("pk_live_123");\nexport default () => <a href="https://freeappstore.online">Store</a>';
    const adsenseHtml =
      '<html lang="en"><head><meta name="viewport"><meta name="apple-mobile-web-app-capable" content="yes"><title>App</title>' +
      '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890123456"></script></head></html>';

    it("a clean project passes both", async () => {
      const output = await runComplianceCheck(makeFiles(), appsConfig);
      expect(output).toContain("PASS: No payments (free tier)");
      expect(output).toContain("PASS: No ads");
      expect(output).not.toContain("FAIL");
    });

    it("fails on Stripe checkout, naming the file and the fix", async () => {
      const output = await runComplianceCheck(makeFiles({ "web/src/App.tsx": stripeApp }), appsConfig);
      expect(output).toMatch(/FAIL: No payments \(free tier\) — .*web\/src\/App\.tsx \(Stripe\)/);
      expect(output).toContain("take no payments");
      expect(output).toContain("PASS: No ads");
    });

    it("fails on AdSense, naming the file and the fix", async () => {
      const output = await runComplianceCheck(makeFiles({ "web/index.html": adsenseHtml }), appsConfig);
      expect(output).toMatch(/FAIL: No ads — .*web\/index\.html \(Google AdSense\)/);
      expect(output).toContain("show no ads");
      expect(output).toContain("PASS: No payments (free tier)");
    });

    it("applies to games too", async () => {
      const output = await runComplianceCheck(
        makeFiles({ "web/src/Ads.ts": "PokiSDK.commercialBreak(() => {})", "web/package.json": '{"dependencies":{"stripe":"^17.0.0"}}' }),
        gamesConfig,
      );
      expect(output).toContain("FAIL: No payments (free tier)");
      expect(output).toContain("FAIL: No ads");
    });

    it("comments and test files don't count", async () => {
      const output = await runComplianceCheck(
        makeFiles({
          "web/src/pay.ts": "// we never call loadStripe( here\nexport const x = 1;",
          "web/src/App.test.tsx": 'expect(html).not.toContain("pagead2.googlesyndication.com")',
        }),
        appsConfig,
      );
      expect(output).not.toContain("FAIL");
    });
  });
});

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { getConfig } from "./config";
import { getTemplateFiles, substituteAppName } from "./template";

// Network/browser release check: FAS_TEST_PUBLISHED=1 pnpm test template-styles.integration
// Uses the actual npm distribution, never the workspace SDK or happy-dom.
it.skipIf(process.env.FAS_TEST_PUBLISHED !== "1")("built Builder presets style the published SDK at 320px (#373)", async () => {
  const root = await mkdtemp(join(tmpdir(), "fas-builder-styles-"));
  console.log(`Builder browser evidence: ${root}`);
  const require = createRequire(new URL("../../../packages/e2e/package.json", import.meta.url));
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch();
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error("Run through pnpm test");
  const run = promisify(execFile);
  try {
    for (const preset of ["standalone", "connected"] as const) {
      const dir = join(root, preset);
      const files = substituteAppName(getTemplateFiles(getConfig("apps"), "generic", preset), "style-check", "Style Check");
      // Pin the independently reported published distribution for reproducibility.
      files["web/package.json"] = files["web/package.json"].replace(/\^0\.16\.\d+/, "0.16.26");
      for (const [name, content] of Object.entries(files)) {
        const target = join(dir, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      const options = { cwd: dir, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };
      await run(process.execPath, [cli, "install", "--no-frozen-lockfile"], options);
      await run(process.execPath, [cli, "build"], options);
      const installed = JSON.parse(await readFile(join(dir, "web/node_modules/@freeappstore/sdk/package.json"), "utf8"));
      expect(installed.version).toBe("0.16.26");
      const server = spawn(process.execPath, [join(dir, "web/node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "5195", "--strictPort"], { cwd: join(dir, "web"), stdio: "pipe" });
      try {
        for (let attempt = 0; ; attempt++) {
          try { if ((await fetch("http://127.0.0.1:5195")).ok) break; } catch {}
          if (attempt >= 100) throw new Error("Preview failed to start");
          await new Promise((done) => setTimeout(done, 100));
        }
        const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
        const errors: string[] = [];
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await page.route("https://fonts.googleapis.com/**", (route: any) => route.abort());
        await page.route("https://api.freeappstore.online/**", (route: any) => route.fulfill({ contentType: "application/json", body: "{}" }));
        await page.goto("http://127.0.0.1:5195");
        const avatar = page.getByRole("link", { name: "Profile", exact: true }).last();
        await avatar.waitFor();
        const bounds = await avatar.boundingBox();
        expect(bounds.width).toBeCloseTo(44, 0);
        expect(bounds.height).toBeCloseTo(44, 0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
        expect(bounds.y).toBeLessThan(30);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
        expect((await page.getByRole("link", { name: "Skip to content" }).boundingBox()).y).toBeLessThan(0);
        await page.screenshot({ path: join(root, `${preset}-home.png`), fullPage: true });
        await avatar.click();
        await page.getByRole("button", { name: /GitHub/ }).waitFor();
        await page.getByRole("button", { name: /Google/ }).waitFor();
        await page.screenshot({ path: join(root, `${preset}-profile.png`), fullPage: true });
        await page.evaluate(() => document.documentElement.setAttribute("data-text", "lg"));
        expect(await page.locator("html").evaluate((el: Element) => getComputedStyle(el).fontSize)).toBe("18px");
        await page.screenshot({ path: join(root, `${preset}-large-text.png`), fullPage: true });
        expect(errors).toEqual([]);
        await page.close();
      } finally { server.kill(); }
    }
  } finally { await browser.close(); }
}, 480_000);

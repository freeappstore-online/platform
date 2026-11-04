import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { getConfig } from "./config";
import { getTemplateFiles, substituteAppName } from "./template";

// FAS_TEST_PUBLISHED=1 pnpm test template-draft.integration
// Exercise generated app-owned UI with the published SDK and real Chromium.
it.skipIf(process.env.FAS_TEST_PUBLISHED !== "1")(
  "generated signed-in draft fits 320px at 200% text and still saves (#378)",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fas-connected-draft-"));
    console.log(`Connected draft browser evidence: ${dir}`);
    const require = createRequire(new URL("../../../packages/e2e/package.json", import.meta.url));
    const { chromium } = require("@playwright/test");
    const browser = await chromium.launch();
    const cli = process.env.npm_execpath;
    if (!cli) throw new Error("Run through pnpm test");
    let server: ReturnType<typeof spawn> | undefined;
    try {
      const files = substituteAppName(getTemplateFiles(getConfig("apps"), "generic", "connected"), "draft-check", "Draft Check");
      files["web/package.json"] = files["web/package.json"].replace(/\^0\.16\.\d+/, "0.16.29");
      for (const [name, content] of Object.entries(files)) {
        const target = join(dir, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      const run = promisify(execFile);
      const options = { cwd: dir, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };
      await run(process.execPath, [cli, "install", "--no-frozen-lockfile"], options);
      await run(process.execPath, [cli, "build"], options);
      server = spawn(
        process.execPath,
        [join(dir, "web/node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "5196", "--strictPort"],
        { cwd: join(dir, "web"), stdio: "pipe" },
      );
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch("http://127.0.0.1:5196")).ok) break;
        } catch {}
        if (attempt >= 100) throw new Error("Preview failed to start");
        await new Promise((done) => setTimeout(done, 100));
      }
      const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.route("https://fonts.googleapis.com/**", (route: any) => route.abort());
      await page.route("https://api.freeappstore.online/**", (route: any) => route.fulfill({ json: {} }));
      const stored = "Plan the next release: review mobile accessibility, save notes, and share feedback. ".repeat(8);
      let saved: unknown;
      await page.route("**/kv/private-draft", async (route: any) => {
        if (route.request().method() === "PUT") saved = route.request().postDataJSON();
        await route.fulfill({ json: stored });
      });
      await page.addInitScript(() =>
        localStorage.setItem(
          "fas:session",
          JSON.stringify({
            token: "synthetic-browser-only",
            user: { id: "test-user", login: "test-user", avatarUrl: null, dateOfBirth: "2000-01-01" },
          }),
        ),
      );
      await page.goto("http://127.0.0.1:5196");
      const input = page.getByRole("textbox", { name: "Your notes" });
      await expect.poll(() => input.inputValue()).toBe(stored);
      for (const size of [16, 32]) {
        await page.locator("html").evaluate((el: HTMLElement, size: number) => {
          el.style.fontSize = `${size}px`;
        }, size);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
        const bounds = await input.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
        expect(await input.evaluate((el: Element) => getComputedStyle(el).resize)).toBe("vertical");
      }
      const edited = `${stored}\nEdited at 200% text.`;
      await input.fill(edited);
      const save = page.getByRole("button", { name: "Save", exact: true });
      await expect.poll(() => save.isEnabled()).toBe(true);
      await save.click();
      await expect.poll(() => saved).toBe(edited);
      await expect.poll(() => save.isDisabled()).toBe(true);
      expect(await input.inputValue()).toBe(edited);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      expect(errors).toEqual([]);
      await page.screenshot({ path: join(dir, "connected-draft-200-percent.png"), fullPage: true });
    } finally {
      server?.kill();
      await browser.close();
    }
  },
  240_000,
);

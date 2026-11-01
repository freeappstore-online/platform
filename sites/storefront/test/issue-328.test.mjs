/** Issue #328: the phone preview keeps app content below the camera island. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  try {
    const found = execFileSync(
      "bash",
      ["-lc", "command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true"],
      { encoding: "utf8" },
    ).trim();
    if (found) return found;
  } catch {
    // fall through
  }
  throw new Error("Chrome is required to measure the phone frame; set CHROME_PATH");
}

function writeFixture(dir) {
  const app = `<!DOCTYPE html><html><head><style>
    html,body{margin:0;background:#fff;color:#1e293b;font-family:system-ui,sans-serif}
    header{height:48px;display:flex;align-items:center;justify-content:center;background:#2563eb;color:#fff}
  </style></head><body><header>Tasks</header><p>Today</p></body></html>`;
  writeFileSync(join(dir, "app.html"), app);
  const page = `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${pathToFileURL(join(ROOT, "style.css")).href}" />
</head><body>
  <main class="container">
    <div class="app-split">
      <div class="app-split-info">
        <h1>Timer</h1>
        <p class="app-description">A countdown timer.</p>
      </div>
      <aside class="app-split-phone">
        <div class="phone-frame">
          <iframe title="Timer live preview" src="app.html"></iframe>
        </div>
      </aside>
    </div>
  </main>
</body></html>`;
  const file = join(dir, "detail.html");
  writeFileSync(file, page);
  return pathToFileURL(file).href;
}

function startChrome() {
  const userData = mkdtempSync(join(tmpdir(), "fas-chrome-328-"));
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
    `--user-data-dir=${userData}`,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const ready = new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Chrome did not open a DevTools port\n${buf}`));
    }, 20_000);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    chrome.stderr.on("data", (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) finish(resolve, match[1]);
    });
    chrome.on("error", (error) => finish(reject, error));
    chrome.on("exit", (code) => finish(reject, new Error(`Chrome exited ${code} before DevTools\n${buf}`)));
  });

  return { chrome, userData, ready };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (!message.method) return;
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.method !== message.method) return true;
        waiter.resolve(message.params);
        return false;
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.next;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  once(method) {
    return new Promise((resolve) => {
      this.waiters.push({ method, resolve });
    });
  }
}

const MEASURE = `(() => {
  const frame = document.querySelector(".phone-frame");
  const iframe = frame.querySelector("iframe");
  const frameRect = frame.getBoundingClientRect();
  const iframeRect = iframe.getBoundingClientRect();
  const frameStyle = getComputedStyle(frame);
  const island = getComputedStyle(frame, "::before");
  const borderTop = parseFloat(frameStyle.borderTopWidth);
  const borderRight = parseFloat(frameStyle.borderRightWidth);
  const borderBottom = parseFloat(frameStyle.borderBottomWidth);
  const borderLeft = parseFloat(frameStyle.borderLeftWidth);
  const islandTop = frameRect.top + borderTop + parseFloat(island.top);
  const islandHeight = parseFloat(island.height);
  const islandBottom = islandTop + islandHeight;
  const x = frameRect.left + borderLeft + 1;
  const y = frameRect.bottom - borderBottom - 1;
  const corner = document.elementFromPoint(x, y);
  const inside = document.elementFromPoint(
    iframeRect.left + iframeRect.width / 2,
    iframeRect.top + Math.min(30, iframeRect.height / 2),
  );
  return {
    iframeTop: iframeRect.top,
    islandBottom,
    islandHeight,
    islandWidth: parseFloat(island.width),
    gap: iframeRect.top - islandBottom,
    iframeBottom: iframeRect.bottom,
    contentBottom: frameRect.bottom - borderBottom,
    iframeLeft: iframeRect.left,
    contentLeft: frameRect.left + borderLeft,
    iframeRight: iframeRect.right,
    contentRight: frameRect.right - borderRight,
    frameWidth: frameRect.width,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    cornerIsIframe: corner === iframe,
    insideIsIframe: inside === iframe,
    overflowX: frameStyle.overflowX,
    radius: parseFloat(frameStyle.borderBottomLeftRadius),
  };
})()`;

async function measureAt(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: MEASURE,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) {
    throw new Error(JSON.stringify(evaluated.exceptionDetails));
  }
  return evaluated.result.value;
}

test("issue #328: iframe starts at or below the camera island and still fits a phone width", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fas-storefront-328-"));
  const url = writeFixture(dir);
  const launched = startChrome();
  let chrome;
  try {
    const browserWs = await launched.ready;
    chrome = launched.chrome;
    const base = browserWs.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
    const targets = await fetch(`${base}/json/list`).then((response) => response.json());
    const page = targets.find((target) => target.type === "page");
    if (!page?.webSocketDebuggerUrl) {
      throw new Error(`Chrome opened no page target: ${JSON.stringify(targets)}`);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const cdp = new Cdp(ws);
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url });
    await loaded;

    const desktop = await measureAt(cdp, 1100, 900);
    assert.equal(desktop.islandHeight, 22, "island stays 22px tall");
    assert.equal(desktop.islandWidth, 110, "island stays 110px wide");
    assert.ok(
      desktop.iframeTop + 0.5 >= desktop.islandBottom,
      `iframe top ${desktop.iframeTop} is above the island bottom ${desktop.islandBottom}`,
    );
    assert.ok(desktop.gap <= 1, `iframe should fill the space under the island, gap was ${desktop.gap}`);
    assert.ok(
      desktop.iframeBottom >= desktop.contentBottom - 1,
      `iframe should reach the bottom of the frame (${desktop.iframeBottom} vs ${desktop.contentBottom})`,
    );
    assert.ok(desktop.iframeLeft >= desktop.contentLeft - 0.5);
    assert.ok(desktop.iframeRight <= desktop.contentRight + 0.5);
    assert.equal(desktop.overflowX, "hidden", "rounded frame must keep clipping");
    assert.ok(desktop.radius >= 26, "bottom corners stay rounded");
    assert.equal(desktop.cornerIsIframe, false, "the rounded bottom corner must clip the iframe");
    assert.equal(desktop.insideIsIframe, true, "the preview still fills the screen under the island");
    assert.ok(Math.abs(desktop.frameWidth - 360) < 1, "desktop phone frame stays 360px");

    for (const width of [360, 400]) {
      const narrow = await measureAt(cdp, width, 800);
      assert.ok(
        narrow.scrollWidth <= narrow.clientWidth + 1,
        `horizontal scroll at ${width}px (scrollWidth ${narrow.scrollWidth}, clientWidth ${narrow.clientWidth})`,
      );
      assert.ok(
        narrow.iframeTop + 0.5 >= narrow.islandBottom,
        `iframe overlaps the island at ${width}px`,
      );
      assert.equal(narrow.cornerIsIframe, false, `bottom corner clip failed at ${width}px`);
    }

    ws.close();
  } finally {
    const proc = chrome ?? launched.chrome;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await new Promise((resolve) => proc.once("exit", resolve));
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(launched.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  }
});

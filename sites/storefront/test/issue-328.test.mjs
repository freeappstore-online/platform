/** Issue #328: the phone preview keeps app content below the camera island. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

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

function startChrome({ launch = spawn, timeoutMs = 10_000, retries = 3 } = {}) {
  const executable = launch === spawn ? findChrome() : "mock-chrome";
  let activeChrome;
  let activeUserData;
  const ready = (async () => {
    const failures = [];
    for (let attempt = 1; attempt <= retries; attempt++) {
      const userData = mkdtempSync(join(tmpdir(), "fas-chrome-328-"));
      let chrome;
      let stderr = "";
      try {
        chrome = launch(executable, [
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
        activeChrome = chrome;
        activeUserData = userData;

        const browserWs = await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
          };
          const timer = setTimeout(() => {
            finish(reject, new Error("Chrome did not open a DevTools port"));
          }, timeoutMs);
          chrome.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) finish(resolve, match[1]);
          });
          chrome.on("error", (error) => finish(reject, error));
          chrome.on("exit", (code, signal) => {
            finish(reject, new Error(`Chrome exited before DevTools (code ${code}, signal ${signal})`));
          });
        });
        return browserWs;
      } catch (error) {
        const diagnostic = `attempt ${attempt} failed: ${error.message}\n${stderr}`;
        failures.push(diagnostic);
        console.error(diagnostic);
        if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
          chrome.kill("SIGKILL");
          await Promise.race([
            new Promise((resolve) => chrome.once("exit", resolve)),
            delay(1_000),
          ]);
        }
        await removeTempDirectory(userData);
        activeChrome = undefined;
        activeUserData = undefined;
      }
    }
    throw new AggregateError(
      failures.map((message) => new Error(message)),
      `Chrome failed to start after ${retries} attempts:\n${failures.join("\n")}`,
    );
  })();

  return {
    get chrome() { return activeChrome; },
    get userData() { return activeUserData; },
    ready,
  };
}

async function removeTempDirectory(path, remove = rmSync) {
  for (let attempt = 0; ; attempt++) {
    try {
      remove(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["ENOTEMPTY", "EBUSY"].includes(error.code) || attempt === 5) throw error;
      // Yield so late Chrome writes can finish before trying the whole tree again.
      await delay(100);
    }
  }
}

for (const code of ["ENOTEMPTY", "EBUSY"]) {
  test(`issue #335: cleanup retries ${code} and removes late Chrome files`, async () => {
    const profile = mkdtempSync(join(tmpdir(), "fas-chrome-335-"));
    let attempts = 0;
    let lateWrite;
    try {
      await removeTempDirectory(profile, (path, options) => {
        if (attempts++ === 0) {
          lateWrite = delay(20).then(() => writeFileSync(join(profile, "late-chrome-file"), "data"));
          throw Object.assign(new Error("Chrome is still writing"), { code });
        }
        assert.ok(existsSync(join(profile, "late-chrome-file")));
        rmSync(path, options);
      });
      assert.equal(attempts, 2);
      assert.equal(existsSync(profile), false);
    } finally {
      await lateWrite;
      rmSync(profile, { recursive: true, force: true });
    }
  });
}

test("issue #335: cleanup reports persistent and unrelated errors", async () => {
  for (const [code, expectedAttempts] of [["ENOTEMPTY", 6], ["EBUSY", 6], ["EACCES", 1]]) {
    let attempts = 0;
    const error = Object.assign(new Error("cannot remove"), { code });
    await assert.rejects(removeTempDirectory("unused", () => {
      attempts++;
      throw error;
    }), (actual) => actual === error);
    assert.equal(attempts, expectedAttempts);
  }
});

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
  let launched;
  let ws;
  try {
    const url = writeFixture(dir);
    launched = startChrome();
    const browserWs = await launched.ready;
    const base = browserWs.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
    const targets = await fetch(`${base}/json/list`).then((response) => response.json());
    const page = targets.find((target) => target.type === "page");
    if (!page?.webSocketDebuggerUrl) {
      throw new Error(`Chrome opened no page target: ${JSON.stringify(targets)}`);
    }
    ws = new WebSocket(page.webSocketDebuggerUrl);
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

  } finally {
    ws?.close();
    const proc = launched?.chrome;
    if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
      await new Promise((resolve) => {
        proc.once("exit", resolve);
        proc.kill("SIGKILL");
      });
    }
    try {
      if (launched) await removeTempDirectory(launched.userData);
    } finally {
      await removeTempDirectory(dir);
    }
  }
});

function mockChrome() {
  const chrome = new EventEmitter();
  chrome.stderr = new EventEmitter();
  chrome.exitCode = null;
  chrome.signalCode = null;
  chrome.kill = (signal) => {
    chrome.signalCode = signal;
    queueMicrotask(() => chrome.emit("exit", null, signal));
  };
  return chrome;
}

test("startChrome retries DevTools timeouts and reports attempt diagnostics", async () => {
  let attempts = 0;
  const launched = startChrome({
    launch: () => {
      attempts++;
      const chrome = mockChrome();
      queueMicrotask(() => chrome.stderr.emit("data", "mock startup output"));
      return chrome;
    },
    timeoutMs: 10,
    retries: 2,
  });
  await assert.rejects(launched.ready, (error) => {
    assert.match(error.message, /DevTools/);
    assert.match(error.message, /attempt 1 failed/);
    assert.match(error.message, /mock startup output/);
    return true;
  });
  assert.equal(attempts, 2);
});

test("startChrome retries Chrome exits before DevTools and reports stderr", async () => {
  let attempts = 0;
  const launched = startChrome({
    launch: () => {
      attempts++;
      const chrome = mockChrome();
      queueMicrotask(() => {
        chrome.stderr.emit("data", "mock early-exit output");
        chrome.exitCode = 1;
        chrome.emit("exit", 1, null);
      });
      return chrome;
    },
    timeoutMs: 100,
    retries: 2,
  });
  await assert.rejects(launched.ready, /Chrome failed to start after 2 attempts/);
  assert.equal(attempts, 2);
});

test("startChrome succeeds on a later DevTools attempt", async () => {
  let attempts = 0;
  const launched = startChrome({
    launch: () => {
      attempts++;
      const chrome = mockChrome();
      if (attempts === 1) {
        queueMicrotask(() => chrome.emit("exit", 1, null));
      } else {
        queueMicrotask(() => chrome.stderr.emit("data", "DevTools listening on ws://127.0.0.1:9222/devtools/browser/mock\n"));
      }
      return chrome;
    },
    timeoutMs: 100,
    retries: 2,
  });
  assert.match(await launched.ready, /^ws:\/\/127\.0\.0\.1:9222/);
  assert.equal(attempts, 2);
  assert.ok(launched.chrome);
  await removeTempDirectory(launched.userData);
});

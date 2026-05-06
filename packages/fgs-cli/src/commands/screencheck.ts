import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, normalize } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Runtime viewport check: builds the app, serves the dist statically,
 * launches a headless browser at the manifest's declared
 * `min_viewport_width` in both portrait and landscape, and measures
 * whether `scrollWidth/Height` exceeds `clientWidth/Height`. Returns
 * non-zero if the app actually scrolls at the size it claims to support.
 *
 * Why a separate command (not folded into `fas check`):
 * - Playwright + Chromium download is ~300 MB; making it a peer dep
 *   keeps the main CLI install light.
 * - A real browser run takes seconds, not the ms `fas check` aims for.
 * - Most creators run `fas check` constantly during dev; runtime
 *   checks are a pre-publish step.
 */

interface ScreenCheckOptions {
  dir: string;
  port: number;
  /** Skip `pnpm build` — assume dist/ is already current. */
  skipBuild: boolean;
}

interface ViewportTest {
  label: string;
  width: number;
  height: number;
}

interface MeasureResult {
  label: string;
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
  scrollsX: boolean;
  scrollsY: boolean;
}

const DEFAULT_PORT = 4571;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const screencheckCommand = new Command('screencheck')
  .description(
    'Run a real browser at the manifest-declared viewport in portrait + landscape and verify the app fits without scrolling.',
  )
  .option('--dir <path>', 'Repo dir to check (defaults to cwd).', process.cwd())
  .option('--port <n>', `Static-server port (default ${DEFAULT_PORT}).`, String(DEFAULT_PORT))
  .option('--skip-build', 'Skip `pnpm build` — assume web/dist is current.', false)
  .action(async (raw: { dir: string; port: string; skipBuild?: boolean }) => {
    const opts: ScreenCheckOptions = {
      dir: raw.dir,
      port: Number(raw.port),
      skipBuild: Boolean(raw.skipBuild),
    };

    const playwright = await loadPlaywright();
    if (!playwright) {
      process.stdout.write(
        '\n⚠  Playwright not installed.\n' +
          '   Run: pnpm add -D playwright && npx playwright install chromium\n' +
          '   Then re-run: fas screencheck\n',
      );
      process.exit(1);
    }

    const manifest = await readManifest(opts.dir);
    if (!manifest) {
      process.stdout.write('\n✗ web/public/manifest.json not found or unparseable.\n');
      process.exit(1);
    }
    const minWidth = typeof manifest['min_viewport_width'] === 'number' ? manifest['min_viewport_width'] : 320;
    const orientation = typeof manifest['orientation'] === 'string' ? manifest['orientation'] : 'any';
    process.stdout.write(`\nManifest: orientation=${orientation} · min ${minWidth}px wide\n`);

    const tests = pickTests(minWidth, orientation);
    if (tests.length === 0) {
      process.stdout.write('\n✗ Manifest orientation is invalid or no test sizes apply.\n');
      process.exit(1);
    }

    if (!opts.skipBuild) {
      process.stdout.write('\nBuilding web/dist…\n');
      await runShell('pnpm', ['build'], opts.dir);
    }

    const distDir = resolve(opts.dir, 'web', 'dist');
    if (!existsSync(distDir)) {
      process.stdout.write(`\n✗ ${distDir} doesn't exist. Run \`pnpm build\` first.\n`);
      process.exit(1);
    }

    const server = await startServer(distDir, opts.port);
    const url = `http://localhost:${opts.port}/`;
    process.stdout.write(`Serving ${distDir} at ${url}\n\n`);

    let exitCode = 0;
    try {
      const browser = await playwright.launch();
      const results: MeasureResult[] = [];
      for (const t of tests) {
        const r = await measure(browser, url, t);
        results.push(r);
        renderResult(r);
      }
      await browser.close();

      const failed = results.filter((r) => r.scrollsX || r.scrollsY).length;
      process.stdout.write('\n');
      if (failed > 0) {
        process.stdout.write(`✗ ${failed}/${results.length} viewports scroll.\n`);
        process.stdout.write('  Review the layout — the manifest claims it works at these sizes.\n');
        exitCode = 1;
      } else {
        process.stdout.write(`✓ All ${results.length} viewports fit cleanly.\n`);
      }
    } finally {
      server.close();
    }
    process.exit(exitCode);
  });

/**
 * Pick the viewport sizes to test based on declared min_width +
 * orientation. We test the declared min in both orientations (when
 * orientation === 'any'), or just the matching orientation otherwise.
 *
 * Heights mirror common device pixel ratios — using 9:19.5 for portrait
 * (iPhone-ish) and 16:9 for landscape.
 */
export function pickTests(minWidth: number, orientation: string): ViewportTest[] {
  const tests: ViewportTest[] = [];
  const portrait = (w: number): ViewportTest => ({
    label: `portrait ${w}×${Math.round(w * (19.5 / 9))}`,
    width: w,
    height: Math.round(w * (19.5 / 9)),
  });
  const landscape = (w: number): ViewportTest => ({
    label: `landscape ${w}×${Math.round(w * (9 / 16))}`,
    width: w,
    height: Math.round(w * (9 / 16)),
  });
  const isPortrait = orientation === 'portrait' || orientation === 'portrait-primary';
  const isLandscape = orientation === 'landscape' || orientation === 'landscape-primary';
  const isAny = orientation === 'any';
  if (isPortrait || isAny) tests.push(portrait(minWidth));
  if (isLandscape || isAny) tests.push(landscape(Math.max(minWidth, 568)));
  return tests;
}

async function measure(
  browser: { newPage: (opts: unknown) => Promise<unknown> },
  url: string,
  t: ViewportTest,
): Promise<MeasureResult> {
  // Cast through unknown — we only call a tiny subset of the Page API
  // and don't want to take a Playwright type dep at module load time.
  const page = (await browser.newPage({ viewport: { width: t.width, height: t.height } })) as {
    goto: (u: string, o?: unknown) => Promise<unknown>;
    evaluate: <T>(fn: () => T) => Promise<T>;
    close: () => Promise<void>;
  };
  await page.goto(url, { waitUntil: 'networkidle' });
  // Small settle delay — fonts, images, late-load JS.
  await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 250)));
  // The function below runs in the browser context, where `document`
  // is defined. TS sees it as Node here; the cast suppresses the
  // resulting "document not found" error without weakening type
  // safety in the rest of this file.
  const dim = await page.evaluate(
    /* eslint-disable @typescript-eslint/no-unused-vars */
    new Function(
      'return { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight };',
    ) as () => {
      scrollWidth: number;
      scrollHeight: number;
      clientWidth: number;
      clientHeight: number;
    },
  );
  await page.close();
  // Use a 1px tolerance — sub-pixel rounding and CSS-zoom quirks can
  // make scrollWidth = clientWidth + 1 even when nothing visibly
  // overflows.
  const TOLERANCE = 1;
  return {
    label: t.label,
    width: t.width,
    height: t.height,
    scrollWidth: dim.scrollWidth,
    scrollHeight: dim.scrollHeight,
    scrollsX: dim.scrollWidth > dim.clientWidth + TOLERANCE,
    scrollsY: dim.scrollHeight > dim.clientHeight + TOLERANCE,
  };
}

function renderResult(r: MeasureResult): void {
  const isTTY = Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] !== '1';
  const c = (open: string) => (s: string) => (isTTY ? `\x1b[${open}m${s}\x1b[39m` : s);
  const ok = c('32');
  const bad = c('31');
  const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[22m` : s);

  if (!r.scrollsX && !r.scrollsY) {
    process.stdout.write(`  ${ok('✓')} ${r.label.padEnd(28)} ${dim(`fits cleanly`)}\n`);
    return;
  }
  const issues: string[] = [];
  if (r.scrollsX) issues.push(`scrolls horizontally (${r.scrollWidth}px > ${r.width}px)`);
  if (r.scrollsY) issues.push(`scrolls vertically (${r.scrollHeight}px > ${r.height}px)`);
  process.stdout.write(`  ${bad('✗')} ${r.label.padEnd(28)} ${dim(issues.join(' · '))}\n`);
}

async function readManifest(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(dir, 'web', 'public', 'manifest.json'), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type Browser = {
  newPage: (opts: unknown) => Promise<unknown>;
  close: () => Promise<void>;
};

async function loadPlaywright(): Promise<{ launch: () => Promise<Browser> } | null> {
  try {
    // playwright is an OPTIONAL peer dep — the user installs it only
    // when they actually run `fas screencheck`. Suppress the type
    // import error so the CLI builds even without it.
    // @ts-expect-error optional peer dep — may not be installed
    const mod = await import('playwright');
    return mod.chromium;
  } catch {
    return null;
  }
}

function runShell(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    child.on('error', rej);
  });
}

async function startServer(rootDir: string, port: number): Promise<{ close: () => void }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const safe = normalize(p).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(rootDir, safe);
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) throw new Error('is dir');
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { close: () => server.close() };
}

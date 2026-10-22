import { INITIAL_LOAD_MAX_GZIP_BYTES, LAZY_ASSET_MAX_BYTES } from '../lib/bundle-limits.js';
import type { FileSource } from '../lib/file-source.js';
import { gzipByteLength } from '../lib/gzip.js';
import { collectInitialJsRefs, jsAssetFileName } from '../lib/html-initial-js.js';
import type { CheckResult } from '../types.js';

export { INITIAL_LOAD_MAX_GZIP_BYTES, LAZY_ASSET_MAX_BYTES };

const ASSETS_DIR = 'web/dist/assets';
const DIST_HTML = 'web/dist/index.html';
const VITE_MANIFEST = 'web/dist/.vite/manifest.json';

const INITIAL_SUGGESTIONS = [
  'Find heavy dependencies: `pnpm dlx vite-bundle-visualizer`',
  'Lazy-load non-critical screens with dynamic import().',
  'Consider lighter alternatives for the biggest deps.',
];

const LAZY_SUGGESTIONS = [
  'Split or compress this lazy asset, or ship a smaller language pack / model.',
  'Keep the heavy file behind dynamic import() / new Worker() / new URL(..., import.meta.url).',
];

/** File names under assets/ that count as JS (entry, chunks, workers). */
function isJsAsset(name: string): boolean {
  return /\.(?:m|c)?js$/i.test(name);
}

/**
 * Lazy code/data that gets the 25 MB cap. Images, fonts, CSS and source
 * maps are not this check's job.
 */
function isLazyCappedAsset(name: string): boolean {
  if (/\.map$/i.test(name)) return false;
  return isJsAsset(name) || /\.(?:wasm|data|bin|onnx|tflite|traineddata|gz|zst)$/i.test(name);
}

export interface BundleSizeOptions {
  /** Override the 300 KB gzip initial-load cap. Tests only. */
  initialMaxGzipBytes?: number;
  /** Override the 25 MB lazy-asset cap. Tests only. */
  lazyMaxBytes?: number;
}

/**
 * Caps the JS the browser downloads on first paint, and separately caps
 * lazily loaded wasm / workers / dynamic chunks.
 *
 * Initial load is the HTML entry plus its static imports (from the Vite
 * manifest when present, otherwise from `<script>` / `modulepreload` plus
 * a walk of static `import` statements). Dynamically imported chunks,
 * workers, `.wasm` and data files are not in that graph: they get a much
 * larger per-asset cap and are reported as info when under it.
 *
 * Returns `warn` if dist hasn't been built yet — we don't want to silently
 * pass when there's nothing to measure.
 *
 * Uses the Web `CompressionStream('gzip')` API rather than `node:zlib` so
 * the same module loads in Cloudflare Workers (the VibeCode agent
 * bundles this package). The agent will always hit the "not built yet"
 * branch since the virtual filesystem holds source, not artefacts.
 */
export async function checkBundleSize(
  source: FileSource,
  opts: BundleSizeOptions = {},
): Promise<CheckResult> {
  const initialMax = opts.initialMaxGzipBytes ?? INITIAL_LOAD_MAX_GZIP_BYTES;
  const lazyMax = opts.lazyMaxBytes ?? LAZY_ASSET_MAX_BYTES;

  if (!source.listDir) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'file source does not support directory listing',
    };
  }
  const entries = await source.listDir(ASSETS_DIR);
  if (entries === null) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'web/dist not built yet — run `pnpm build` to measure',
    };
  }

  const jsFiles = entries.filter(isJsAsset);
  if (jsFiles.length === 0) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: `no JS files in ${ASSETS_DIR}`,
    };
  }

  if (!source.readBytes) {
    return {
      name: 'Bundle size',
      status: 'warn',
      detail: 'file source does not support binary reads',
    };
  }

  const initialJs = await resolveInitialJs(source, jsFiles);
  const measured = await measureLargestGzip(source, initialJs);
  if (!measured) {
    return { name: 'Bundle size', status: 'warn', detail: `no readable JS in ${ASSETS_DIR}` };
  }

  const lazyOver: { name: string; bytes: number }[] = [];
  let lazyLargest: { name: string; bytes: number } | null = null;
  for (const f of entries) {
    if (initialJs.has(f)) continue;
    if (!isLazyCappedAsset(f)) continue;
    const bytes = await source.readBytes(`${ASSETS_DIR}/${f}`);
    if (!bytes) continue;
    const size = bytes.byteLength;
    if (!lazyLargest || size > lazyLargest.bytes) lazyLargest = { name: f, bytes: size };
    if (size > lazyMax) lazyOver.push({ name: f, bytes: size });
  }

  const limitKb = (initialMax / 1024).toFixed(0);
  const lazyLimitLabel = formatCap(lazyMax);
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (measured.gzipped > initialMax) {
    issues.push(`${measured.name}: ${formatKb(measured.gzipped)} KB gzipped (limit ${limitKb} KB)`);
    suggestions.push(...INITIAL_SUGGESTIONS);
  }
  for (const over of lazyOver) {
    issues.push(`${over.name}: ${formatSize(over.bytes)} (limit ${lazyLimitLabel} per lazy asset)`);
  }
  if (lazyOver.length > 0) suggestions.push(...LAZY_SUGGESTIONS);

  if (issues.length > 0) {
    return { name: 'Bundle size', status: 'fail', detail: issues.join('; '), suggestions };
  }

  let detail = `${measured.name}: ${formatKb(measured.gzipped)} KB gzipped (limit ${limitKb} KB)`;
  if (lazyLargest) {
    detail += `; lazy ${lazyLargest.name} ${formatSize(lazyLargest.bytes)} (limit ${lazyLimitLabel})`;
  }
  return { name: 'Bundle size', status: 'pass', detail };
}

function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

/** Human size for a lazy asset. Sub-megabyte files stay in KB so a 400 KB
 *  chunk is not reported as 0.0 MB. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatCap(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  return formatSize(bytes);
}

async function measureLargestGzip(
  source: FileSource,
  files: Set<string>,
): Promise<{ name: string; gzipped: number } | null> {
  let largest: { name: string; gzipped: number } | null = null;
  for (const f of files) {
    const content = await source.readBytes?.(`${ASSETS_DIR}/${f}`);
    if (!content) continue;
    const gzipped = await gzipByteLength(content);
    if (!largest || gzipped > largest.gzipped) largest = { name: f, gzipped };
  }
  return largest;
}

/**
 * Files in the initial-load JS graph. Prefer the Vite manifest (HTML
 * entries + static `imports`, never `dynamicImports` or worker entries).
 * Fall back to index.html + a walk of static ESM imports. If neither
 * exists, every JS asset is treated as initial — same as the old
 * largest-file check, so a missing HTML can't silently ignore a huge
 * bundle.
 */
async function resolveInitialJs(source: FileSource, jsFiles: string[]): Promise<Set<string>> {
  const fromManifest = await initialJsFromViteManifest(source);
  if (fromManifest && fromManifest.size > 0) return keepExisting(fromManifest, jsFiles);

  const fromHtml = await initialJsFromHtml(source);
  if (fromHtml && fromHtml.size > 0) {
    const walked = await followStaticImports(source, fromHtml);
    return keepExisting(walked, jsFiles);
  }

  return new Set(jsFiles);
}

function keepExisting(names: Set<string>, jsFiles: string[]): Set<string> {
  const known = new Set(jsFiles);
  const out = new Set<string>();
  for (const n of names) if (known.has(n)) out.add(n);
  // Manifest/HTML pointed at files we couldn't list — don't fail closed
  // with an empty graph (that would skip the 300 KB cap).
  return out.size > 0 ? out : new Set(jsFiles);
}

interface ViteChunk {
  file?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

async function initialJsFromViteManifest(source: FileSource): Promise<Set<string> | null> {
  const raw = await source.read(VITE_MANIFEST);
  if (!raw) return null;
  let manifest: Record<string, ViteChunk>;
  try {
    manifest = JSON.parse(raw) as Record<string, ViteChunk>;
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;

  const queue: string[] = [];
  for (const [key, chunk] of Object.entries(manifest)) {
    if (!chunk?.isEntry) continue;
    if (key.endsWith('.html') || chunk.src?.endsWith('.html')) queue.push(key);
  }
  if (queue.length === 0) return null;

  const initial = new Set<string>();
  const visited = new Set<string>();
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) continue;
    const asset = distAssetName(chunk.file);
    if (asset && isJsAsset(asset)) initial.add(asset);
    for (const imp of chunk.imports ?? []) queue.push(imp);
  }
  return initial;
}

function distAssetName(file: string | undefined): string | null {
  if (!file) return null;
  const normalized = file.replace(/^\.\//, '');
  if (normalized.startsWith('assets/')) return normalized.slice('assets/'.length);
  return null;
}

async function initialJsFromHtml(source: FileSource): Promise<Set<string> | null> {
  const html = await source.read(DIST_HTML);
  if (!html) return null;
  const names = new Set<string>();
  for (const ref of collectInitialJsRefs(html)) {
    const name = jsAssetFileName(ref);
    if (name) names.add(name);
  }
  return names.size > 0 ? names : null;
}

async function followStaticImports(source: FileSource, roots: Set<string>): Promise<Set<string>> {
  const out = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (out.has(file)) continue;
    out.add(file);
    const text = await readText(source, `${ASSETS_DIR}/${file}`);
    if (!text) continue;
    for (const spec of staticImportSpecs(text)) {
      if (!isJsAsset(spec.split(/[?#]/, 1)[0]!)) continue;
      const resolved = resolveRelative(file, spec);
      if (resolved && !out.has(resolved)) queue.push(resolved);
    }
  }
  return out;
}

/**
 * Vite's production output uses static `import "./chunk.js"` / `import{x}from"./v.js"`.
 * Dynamic `import("./x.js")` is deliberately not matched — those chunks are lazy.
 * The regex is constructed per call so a global lastIndex cannot leak.
 */
function staticImportSpecs(js: string): string[] {
  const re =
    /(?:^|[\n;])\s*(?:import|export)\s*(?:type\s+)?(?:[^\n'"()]*?from\s*)?["'](\.[^"']+)["']/g;
  const specs: string[] = [];
  for (const m of js.matchAll(re)) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

function resolveRelative(fromFile: string, spec: string): string {
  const path = spec.split(/[?#]/, 1)[0]!;
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const parts = [...(fromDir ? fromDir.split('/') : []), ...path.split('/')];
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

async function readText(source: FileSource, path: string): Promise<string | null> {
  const text = await source.read(path);
  if (text !== null) return text;
  const bytes = await source.readBytes?.(path);
  if (!bytes) return null;
  return new TextDecoder().decode(bytes);
}

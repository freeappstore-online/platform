import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_LOAD_MAX_GZIP_BYTES, LAZY_ASSET_MAX_BYTES } from '../lib/bundle-limits.js';
import { fsFileSource } from '../lib/file-source.js';
import { checkBundleSize } from './bundle-size.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeAsset(name: string, content: string | Buffer): Promise<void> {
  const p = join(dir, 'web', 'dist', 'assets');
  await mkdir(p, { recursive: true });
  await writeFile(join(p, name), content);
}

async function writeIndex(entry: string, preloads: string[] = []): Promise<void> {
  const links = preloads.map((p) => `<link rel="modulepreload" href="/assets/${p}">`).join('\n');
  const html = `<!doctype html><html><head>${links}<script type="module" src="/assets/${entry}"></script></head></html>`;
  await mkdir(join(dir, 'web', 'dist'), { recursive: true });
  await writeFile(join(dir, 'web', 'dist', 'index.html'), html);
}

async function writeViteManifest(manifest: unknown): Promise<void> {
  const p = join(dir, 'web', 'dist', '.vite');
  await mkdir(p, { recursive: true });
  await writeFile(join(p, 'manifest.json'), JSON.stringify(manifest));
}

function incompressible(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

describe('checkBundleSize', () => {
  it('warns when web/dist not built', async () => {
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/pnpm build/);
  });

  it('warns when no JS files in assets', async () => {
    const p = join(dir, 'web', 'dist', 'assets');
    await mkdir(p, { recursive: true });
    await writeFile(join(p, 'styles.css'), 'body{color:red}');
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/no JS/);
  });

  it('passes when largest JS is under 300KB gzipped', async () => {
    // ~100KB of repetitive content gzips to a few KB
    await writeAsset('index-abc.js', 'a'.repeat(100_000));
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/index-abc\.js/);
    expect(r.detail).toMatch(/limit 300 KB/);
  });

  it('without an entry HTML, measures the largest JS file (legacy fallback)', async () => {
    await writeAsset('small.js', 'tiny');
    await writeAsset('big.js', 'a'.repeat(200_000));
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.detail).toMatch(/big\.js/);
  });

  it('fails when largest JS exceeds 300KB gzipped', async () => {
    // Random bytes don't compress, so 400KB of randomness ~= 400KB gzipped.
    await writeAsset('huge.js', incompressible(400 * 1024));
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.suggestions?.length ?? 0).toBeGreaterThan(0);
  });

  it('passes a small entry even when a large dynamic JS chunk sits next to it', async () => {
    await writeAsset('index-abc.js', 'a'.repeat(1000));
    await writeAsset('ocr-chunk.js', incompressible(400 * 1024));
    await writeIndex('index-abc.js');
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/index-abc\.js: .*limit 300 KB/);
    expect(r.detail).toMatch(/lazy ocr-chunk\.js/);
  });

  it('passes a small entry with a large lazy wasm chunk', async () => {
    await writeAsset('index-abc.js', 'export default 1;\n');
    await writeAsset('tesseract-core.wasm', incompressible(400 * 1024));
    await writeIndex('index-abc.js');
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/index-abc\.js/);
    expect(r.detail).toMatch(/lazy tesseract-core\.wasm/);
    expect(r.detail).toMatch(/limit 25 MB/);
  });

  it('fails when the entry chunk itself exceeds 300KB gzipped', async () => {
    await writeAsset('index-big.js', incompressible(400 * 1024));
    await writeAsset('ocr.wasm', incompressible(50_000));
    await writeIndex('index-big.js');
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/index-big\.js/);
    expect(r.detail).toMatch(/limit 300 KB/);
  });

  it('counts a statically imported vendor chunk as initial load', async () => {
    await writeAsset('index-abc.js', 'import{n as e}from"./vendor-xyz.js";\n');
    await writeAsset('vendor-xyz.js', incompressible(400 * 1024));
    await writeIndex('index-abc.js');
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/vendor-xyz\.js/);
  });

  it('does not count a dynamic import() chunk as initial load', async () => {
    await writeAsset(
      'index-abc.js',
      'export async function ocr(){return import("./ocr-chunk.js")}',
    );
    await writeAsset('ocr-chunk.js', incompressible(400 * 1024));
    await writeIndex('index-abc.js');
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/index-abc\.js/);
    expect(r.detail).toMatch(/lazy ocr-chunk\.js/);
  });

  it('treats modulepreload hrefs as initial load', async () => {
    await writeAsset('index-abc.js', 'console.log(1)');
    await writeAsset('vendor-xyz.js', incompressible(400 * 1024));
    await writeIndex('index-abc.js', ['vendor-xyz.js']);
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/vendor-xyz\.js/);
  });

  it('uses the Vite manifest: static imports count, dynamicImports do not', async () => {
    await writeAsset('index-abc.js', 'a'.repeat(1000));
    await writeAsset('vendor-xyz.js', 'a'.repeat(1000));
    await writeAsset('ocr-chunk.js', incompressible(400 * 1024));
    await writeViteManifest({
      'index.html': {
        file: 'index.html',
        src: 'index.html',
        isEntry: true,
        imports: ['src/main.tsx'],
        dynamicImports: ['src/ocr.ts'],
      },
      'src/main.tsx': {
        file: 'assets/index-abc.js',
        imports: ['_vendor'],
      },
      _vendor: { file: 'assets/vendor-xyz.js' },
      'src/ocr.ts': {
        file: 'assets/ocr-chunk.js',
        isDynamicEntry: true,
      },
    });
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/lazy ocr-chunk\.js/);
  });

  it('counts the Vite HTML entry when its manifest file is the JS bundle', async () => {
    // Vite 5+ writes the entry chunk on the HTML key itself (`file` is the
    // hashed JS), and lists dynamic chunks only under dynamicImports.
    await writeAsset('index-abc.js', 'a'.repeat(1000));
    await writeAsset('ocr-chunk.js', incompressible(400 * 1024));
    await writeViteManifest({
      'index.html': {
        file: 'assets/index-abc.js',
        name: 'index',
        src: 'index.html',
        isEntry: true,
        dynamicImports: ['src/ocr.ts'],
      },
      'src/ocr.ts': {
        file: 'assets/ocr-chunk.js',
        src: 'src/ocr.ts',
        isDynamicEntry: true,
      },
    });
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/index-abc\.js/);
    expect(r.detail).toMatch(/lazy ocr-chunk\.js/);
  });

  it('does not treat a Vite worker isEntry as initial load', async () => {
    await writeAsset('index-abc.js', 'a'.repeat(1000));
    await writeAsset('pdf.worker.js', incompressible(400 * 1024));
    await writeViteManifest({
      'index.html': {
        file: 'index.html',
        src: 'index.html',
        isEntry: true,
        imports: ['src/main.tsx'],
      },
      'src/main.tsx': { file: 'assets/index-abc.js' },
      'src/pdf.worker.ts': {
        file: 'assets/pdf.worker.js',
        src: 'src/pdf.worker.ts',
        isEntry: true,
      },
    });
    const r = await checkBundleSize(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/lazy pdf\.worker\.js/);
  });

  it('fails a lazy asset over the per-asset cap', async () => {
    await writeAsset('index-abc.js', 'export default 1;\n');
    await writeAsset('huge.wasm', incompressible(8 * 1024));
    await writeIndex('index-abc.js');
    const r = await checkBundleSize(fsFileSource(dir), { lazyMaxBytes: 1024 });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/huge\.wasm/);
    expect(r.detail).toMatch(/per lazy asset/);
    expect(r.suggestions?.some((s) => /lazy asset/i.test(s) || /compress/i.test(s))).toBe(true);
  });

  it('ignores source maps when applying the lazy cap', async () => {
    await writeAsset('index-abc.js', 'export default 1;\n');
    await writeAsset('index-abc.js.map', incompressible(8 * 1024));
    await writeIndex('index-abc.js');
    const r = await checkBundleSize(fsFileSource(dir), { lazyMaxBytes: 1024 });
    expect(r.status).toBe('pass');
    expect(r.detail).not.toMatch(/\.map/);
  });

  it('documents the production caps', () => {
    expect(INITIAL_LOAD_MAX_GZIP_BYTES).toBe(300 * 1024);
    expect(LAZY_ASSET_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});

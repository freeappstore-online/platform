import { describe, expect, it } from 'vitest';
import { collectInitialJsRefs, jsAssetFileName } from './html-initial-js.js';

describe('collectInitialJsRefs', () => {
  it('collects the entry script', () => {
    const html = '<script type="module" src="/assets/index-abc.js"></script>';
    expect(collectInitialJsRefs(html)).toEqual(['/assets/index-abc.js']);
  });

  it('collects modulepreload hrefs regardless of attribute order', () => {
    const html = `
      <link href="/assets/vendor-xyz.js" rel="modulepreload" crossorigin>
      <link rel="modulepreload" href="/assets/chunk-1.js">
      <script type="module" src="/assets/index-abc.js"></script>
    `;
    expect(collectInitialJsRefs(html)).toEqual([
      '/assets/index-abc.js',
      '/assets/vendor-xyz.js',
      '/assets/chunk-1.js',
    ]);
  });

  it('ignores stylesheets, wasm, and non-js preloads', () => {
    const html = `
      <link rel="stylesheet" href="/assets/index.css">
      <link rel="modulepreload" href="/assets/ocr.wasm">
      <script src="/assets/index.js"></script>
    `;
    expect(collectInitialJsRefs(html)).toEqual(['/assets/index.js']);
  });

  it('dedupes identical refs', () => {
    const html = `
      <link rel="modulepreload" href="/assets/index.js">
      <script src="/assets/index.js"></script>
    `;
    expect(collectInitialJsRefs(html)).toEqual(['/assets/index.js']);
  });

  it('does not treat data-src as the script that loads', () => {
    const html = '<script data-src="/assets/huge.js" src="/assets/index.js"></script>';
    expect(collectInitialJsRefs(html)).toEqual(['/assets/index.js']);
  });
});

describe('jsAssetFileName', () => {
  it('strips /assets/ and query strings', () => {
    expect(jsAssetFileName('/assets/index-abc.js')).toBe('index-abc.js');
    expect(jsAssetFileName('./assets/vendor.js?v=1')).toBe('vendor.js');
    expect(jsAssetFileName('https://app.example/assets/foo.mjs')).toBe('foo.mjs');
  });

  it('returns null for non-asset or non-js refs', () => {
    expect(jsAssetFileName('/sw.js')).toBeNull();
    expect(jsAssetFileName('/assets/index.css')).toBeNull();
  });
});

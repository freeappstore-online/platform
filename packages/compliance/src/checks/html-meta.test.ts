import { describe, it, expect } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkHtmlMeta } from './html-meta.js';

describe('checkHtmlMeta', () => {
  it('passes with all three: lang, viewport, title', async () => {
    const files = new Map([[
      'web/index.html',
      `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My App</title>
  </head>
</html>`,
    ]]);
    const r = await checkHtmlMeta(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('fails when index.html missing entirely', async () => {
    const r = await checkHtmlMeta(mapFileSource(new Map()));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/not found/);
  });

  it('fails listing the missing pieces', async () => {
    const files = new Map([['web/index.html', '<html><head><title></title></head></html>']]);
    const r = await checkHtmlMeta(mapFileSource(files));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/lang attribute/);
    expect(r.detail).toMatch(/viewport meta/);
    expect(r.detail).toMatch(/non-empty <title>/);
  });

  it('treats whitespace-only <title> as empty', async () => {
    const files = new Map([[
      'web/index.html',
      '<html lang="en"><head><meta name="viewport" content="x"/><title>   </title></head></html>',
    ]]);
    const r = await checkHtmlMeta(mapFileSource(files));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/<title>/);
  });

  it('accepts a title with leading whitespace (trimmed)', async () => {
    // Regression: earlier regex `[^<\s]` rejected the first char being
    // whitespace, falsely reporting `<title> My App</title>` as empty.
    const files = new Map([[
      'web/index.html',
      '<html lang="en"><head><meta name="viewport" content="x"/><title> My App</title></head></html>',
    ]]);
    const r = await checkHtmlMeta(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('accepts a multi-line title body', async () => {
    const files = new Map([[
      'web/index.html',
      `<html lang="en">
<head>
  <meta name="viewport" content="x" />
  <title>
    My App
  </title>
</head>
</html>`,
    ]]);
    const r = await checkHtmlMeta(mapFileSource(files));
    expect(r.status).toBe('pass');
  });
});

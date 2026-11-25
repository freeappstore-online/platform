import { describe, expect, it } from 'vitest';
import worker, { type Env, keyForPath, timingSafeEqual } from './index.js';

describe('keyForPath', () => {
  it('maps app KB paths by slug on the KB host', () => {
    expect(keyForPath('/timer/', 'kb.freeappstore.online')).toBe('timer/index.html');
    expect(keyForPath('/timer/setup/', 'kb.freeappstore.online')).toBe('timer/setup/index.html');
    expect(keyForPath('/timer/assets/app.css', 'kb.freeappstore.online')).toBe(
      'timer/assets/app.css',
    );
  });

  it('maps the docs host root to the platform docs prefix', () => {
    expect(keyForPath('/', 'docs.freeappstore.online')).toBe('platform/index.html');
    expect(keyForPath('/sdk/', 'docs.freeappstore.online')).toBe('platform/sdk/index.html');
    expect(keyForPath('/cli/', 'docs.freeappstore.online')).toBe('platform/cli/index.html');
  });

  it('rejects traversal attempts', () => {
    expect(keyForPath('/../secret', 'kb.freeappstore.online')).toBeNull();
    expect(keyForPath('/../secret', 'docs.freeappstore.online')).toBeNull();
  });
});

describe('malformed percent escapes (#575)', () => {
  it('keyForPath returns null instead of throwing', () => {
    expect(keyForPath('/timer/%E0%A4%A', 'kb.freeappstore.online')).toBeNull();
    expect(keyForPath('/%', 'docs.freeappstore.online')).toBeNull();
  });
});

describe('timingSafeEqual', () => {
  it('compares every character regardless of where strings differ', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'xbc')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('PUT /_ingest (#494)', () => {
  function env(token: string | undefined) {
    const puts: string[] = [];
    const KB_R2 = {
      put: async (key: string) => {
        puts.push(key);
      },
    } as unknown as R2Bucket;
    return { env: { KB_R2, KB_INGEST_TOKEN: token } as Env, puts };
  }
  const put = (e: Env, token?: string) =>
    worker.fetch(
      new Request('https://kb.freeappstore.online/_ingest/timer/index.html', {
        method: 'PUT',
        headers: token ? { 'x-internal-token': token } : {},
        body: '<p>hi</p>',
      }),
      e,
    );

  it('writes with the right token and refuses a wrong, missing or unset one', async () => {
    const ok = env('s3cret');
    expect((await put(ok.env, 's3cret')).status).toBe(200);
    expect(ok.puts).toEqual(['timer/index.html']);

    const bad = env('s3cret');
    expect((await put(bad.env, 's3cres')).status).toBe(403);
    expect((await put(bad.env, 's3cret2')).status).toBe(403);
    expect((await put(bad.env)).status).toBe(403);
    expect(bad.puts).toEqual([]);

    const unset = env(undefined);
    expect((await put(unset.env, '')).status).toBe(403);
    expect(unset.puts).toEqual([]);
  });

  it('uses the constant-time compare for the token', async () => {
    // Guards against a regression to `!==`: the helper must be what decides.
    // Compiled against workers-types only, so node:fs is loaded dynamically.
    const nodeModule = <T>(name: string) => import(/* @vite-ignore */ name) as Promise<T>;
    const fs = await nodeModule<{ readFileSync(file: URL, encoding: 'utf8'): string }>('node:fs');
    const src = fs.readFileSync(
      new URL('./index.ts', (import.meta as unknown as { url: string }).url),
      'utf8',
    );
    const ingest = src.slice(src.indexOf("'/_ingest/'"), src.indexOf('KB_R2.put'));
    expect(ingest).toContain('timingSafeEqual(provided, env.KB_INGEST_TOKEN)');
    expect(ingest).not.toMatch(/!==\s*env\.KB_INGEST_TOKEN/);
  });
});

describe('GET serving (#687)', () => {
  function bucket(files: Record<string, string>) {
    return {
      KB_R2: {
        get: async (key: string) =>
          key in files ? { body: files[key], httpEtag: `"etag-${key}"` } : null,
      } as unknown as R2Bucket,
      KB_INGEST_TOKEN: 't',
    } as Env;
  }
  const get = (url: string, e: Env, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(url, { headers, redirect: 'manual' }), e);

  it('serves an app page with its content type and an html cache policy', async () => {
    const res = await get(
      'https://kb.freeappstore.online/timer/',
      bucket({ 'timer/index.html': '<h1>t</h1>' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
    expect(res.headers.get('etag')).toBe('"etag-timer/index.html"');
    expect(await res.text()).toBe('<h1>t</h1>');
  });

  it('serves platform docs from the platform prefix on the docs host', async () => {
    const res = await get(
      'https://docs.freeappstore.online/sdk/',
      bucket({ 'platform/sdk/index.html': 'sdk' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('sdk');
  });

  it('301s docs.freeappstore.online/platform/* to the unprefixed path', async () => {
    const e = bucket({});
    const deep = await get('https://docs.freeappstore.online/platform/sdk/?x=1', e);
    expect(deep.status).toBe(301);
    expect(deep.headers.get('location')).toBe('https://docs.freeappstore.online/sdk/?x=1');
    const bare = await get('https://docs.freeappstore.online/platform', e);
    expect(bare.status).toBe(301);
    expect(bare.headers.get('location')).toBe('https://docs.freeappstore.online/');
  });

  it("answers a missing page with the app's own 404.html, else a plain 404", async () => {
    const withCustom = await get(
      'https://kb.freeappstore.online/timer/nope/',
      bucket({ 'timer/404.html': 'custom' }),
    );
    expect(withCustom.status).toBe(404);
    expect(withCustom.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await withCustom.text()).toBe('custom');

    const plain = await get('https://kb.freeappstore.online/timer/nope/', bucket({}));
    expect(plain.status).toBe(404);
    expect(await plain.text()).toBe('Not found');
  });

  it('answers 304 when If-None-Match matches the object etag', async () => {
    const e = bucket({ 'timer/assets/app.css': 'body{}' });
    const res = await get('https://kb.freeappstore.online/timer/assets/app.css', e, {
      'if-none-match': '"etag-timer/assets/app.css"',
    });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('"etag-timer/assets/app.css"');
    const fresh = await get('https://kb.freeappstore.online/timer/assets/app.css', e);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('404s the bare KB host and refuses other methods', async () => {
    expect((await get('https://kb.freeappstore.online/', bucket({}))).status).toBe(404);
    const post = await worker.fetch(
      new Request('https://kb.freeappstore.online/timer/', { method: 'POST' }),
      bucket({}),
    );
    expect(post.status).toBe(405);
  });
});

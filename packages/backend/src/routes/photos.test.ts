import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { PHOTO_MAX_BYTES, sanitizePhoto } from '../lib/photo-image.js';
import { signSession } from '../lib/session.js';
import { hasSqlite, sqliteD1 } from '../lib/sqlite-d1.testutil.js';
import { PHOTO_QUOTAS, prunePhotos } from './photos.js';

const KEY = 'a'.repeat(64);
let jpeg: Uint8Array;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#ad753a' } })
    .jpeg()
    .toBuffer();
});

function setup() {
  const { db, d1 } = sqliteD1();
  db.exec(`INSERT INTO users (id, github_id, github_login, created_at) VALUES ('u1', 1, 'alice', 0), ('u2', 2, 'bob', 0);
    INSERT INTO apps (id, owner_login, created_at) VALUES ('wood', 'alice', 0), ('other', 'alice', 0);`);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    async put(key: string, bytes: Uint8Array) {
      objects.set(key, bytes);
    },
    async get(key: string) {
      const b = objects.get(key);
      return b ? { body: b, size: b.length } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  const env = { DB: d1, SESSION_SIGNING_KEY: KEY, UPLOADS: bucket };
  const request = async (
    path = '',
    options: {
      method?: string;
      user?: string | null;
      audience?: string;
      body?: Uint8Array;
      type?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const {
      user = 'u1',
      audience = 'wood',
      method = 'GET',
      body,
      type = 'image/jpeg',
      headers = {},
    } = options;
    return app.request(
      `/v1/apps/wood/photos${path}`,
      {
        method,
        headers: {
          ...(user
            ? { Authorization: `Bearer ${await signSession(user, KEY, { aud: audience })}` }
            : {}),
          ...(body ? { 'Content-Type': type } : {}),
          ...headers,
        },
        ...(body ? { body: body as BodyInit } : {}),
      },
      env,
    );
  };
  const upload = (path = '?visibility=public') => request(path, { method: 'POST', body: jpeg });
  return { db, d1, env, objects, request, upload };
}

describe('photo image limits and metadata', () => {
  it('accepts real JPEG and strips EXIF/GPS and comments', async () => {
    const original = await sharp(jpeg)
      .withMetadata({ exif: { IFD0: { Artist: 'private-person' } } })
      .jpeg()
      .toBuffer();
    const clean = sanitizePhoto(original);
    expect(clean.width).toBe(640);
    expect(clean.height).toBe(480);
    expect((await sharp(clean.bytes).metadata()).exif).toBeUndefined();
    expect(await sharp(clean.bytes).raw().toBuffer()).toHaveLength(640 * 480 * 3);
  });
  it('accepts lossy, lossless and alpha WebP and strips metadata', async () => {
    for (const lossless of [true, false]) {
      const bytes = await sharp({
        create: { width: 400, height: 300, channels: 4, background: '#ff000080' },
      })
        .withMetadata()
        .webp({ lossless })
        .toBuffer();
      const clean = sanitizePhoto(bytes);
      expect([clean.width, clean.height]).toEqual([400, 300]);
      expect((await sharp(clean.bytes).metadata()).exif).toBeUndefined();
      expect((await sharp(clean.bytes).metadata()).width).toBe(400);
    }
  });
  it('rejects dimensions over 640 even for a tiny file', async () => {
    const bytes = await sharp({
      create: { width: 641, height: 1, channels: 3, background: '#fff' },
    })
      .jpeg()
      .toBuffer();
    expect(() => sanitizePhoto(bytes)).toThrow(/640/);
  });
  it('rejects SVG, PNG, truncated files, trailing payloads and over-limit bytes', () => {
    for (const bytes of [
      new TextEncoder().encode('<svg/>'),
      jpeg.slice(0, -3),
      new Uint8Array([...jpeg, 42]),
      new Uint8Array(PHOTO_MAX_BYTES + 1),
    ]) {
      expect(() => sanitizePhoto(bytes)).toThrow();
    }
  });
});

describe.skipIf(!hasSqlite)('photo API with real SQLite quota reservations', () => {
  it('requires sign-in, a matching app audience and a real FAS app', async () => {
    const s = setup();
    expect((await s.request('', { method: 'POST', user: null, body: jpeg })).status).toBe(401);
    expect((await s.request('', { method: 'POST', audience: 'other', body: jpeg })).status).toBe(
      403,
    );
    s.db.exec("UPDATE apps SET store = 'apps_pro' WHERE id = 'wood'");
    expect((await s.upload()).status).toBe(404);
    expect(s.objects.size).toBe(0);
  });
  it('private by default; owners can read, other users and anonymous callers cannot', async () => {
    const s = setup();
    const response = await s.upload('');
    expect(response.status).toBe(201);
    const photo = (await response.json()) as {
      id: string;
      visibility: string;
      expiresAt: number;
      createdAt: number;
    };
    expect(photo.visibility).toBe('private');
    expect(photo.expiresAt - photo.createdAt).toBe(90 * 86400000);
    expect((await s.request(`/${photo.id}`)).status).toBe(200);
    expect((await s.request(`/${photo.id}`, { user: null })).status).toBe(401);
    expect((await s.request(`/${photo.id}`, { user: 'u2' })).status).toBe(404);
    expect((await s.request(`/${photo.id}`, { user: 'u2', method: 'DELETE' })).status).toBe(404);
    expect(s.objects.size).toBe(1);
  });
  it('explicit public reads, deletion and precise expiry despite delayed lifecycle cleanup', async () => {
    const s = setup();
    const response = await s.upload();
    const photo = (await response.json()) as { id: string };
    const get = await s.request(`/${photo.id}`, { user: null });
    expect(get.status).toBe(200);
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(sanitizePhoto(jpeg).bytes);
    s.db.prepare('UPDATE photos SET expires_at = ?').run(Date.now() - 1);
    expect((await s.request(`/${photo.id}`, { user: null })).status).toBe(404);
    await prunePhotos(s.env as never);
    expect(s.objects.size).toBe(0);
  });
  it('validates streamed bytes, MIME and dimensions before storing or reserving quota', async () => {
    const s = setup();
    expect(
      (await s.request('', { method: 'POST', body: new Uint8Array(PHOTO_MAX_BYTES + 1) })).status,
    ).toBe(413);
    expect((await s.request('', { method: 'POST', body: jpeg, type: 'image/webp' })).status).toBe(
      415,
    );
    expect((await s.request('', { method: 'POST', body: jpeg, type: 'text/html' })).status).toBe(
      415,
    );
    expect(s.objects.size).toBe(0);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM photos').get()).toEqual(
      expect.objectContaining({ n: 0 }),
    );
  });
  it('concurrent uploads cannot exceed the global per-user daily cap; deleting cannot reset it', async () => {
    const s = setup();
    // Race through the real conditional INSERT at the last available slot.
    for (let i = 0; i < PHOTO_QUOTAS.userDaily - 1; i++) {
      const response = await s.upload();
      expect(response.status).toBe(201);
      const photo = (await response.json()) as { id: string };
      expect((await s.request(`/${photo.id}`, { method: 'DELETE' })).status).toBe(204);
    }
    const statuses = await Promise.all(
      Array.from({ length: 4 }, async () => (await s.upload()).status),
    );
    expect(statuses.filter((x) => x === 201)).toHaveLength(1);
    expect(statuses.filter((x) => x === 429)).toHaveLength(3);
    expect(s.objects.size).toBe(1);
    expect((await s.request('', { method: 'POST', audience: 'console', body: jpeg })).status).toBe(
      429,
    );
  });
  it('applies live file and byte caps in the reservation and preserves other apps objects', async () => {
    const s = setup();
    const first = await s.upload();
    const photo = (await first.json()) as { id: string };
    s.db.prepare('UPDATE photos SET bytes = ?').run(PHOTO_QUOTAS.userBytes);
    expect((await s.upload()).status).toBe(429);
    expect((await s.request(`/${photo.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await s.upload()).status).toBe(201);
  });
  it('account deletion hides public photos immediately, with orphan cleanup retryable', async () => {
    const s = setup();
    const photo = (await (await s.upload()).json()) as { id: string };
    s.db.exec("DELETE FROM users WHERE id = 'u1'");
    expect((await s.request(`/${photo.id}`, { user: null })).status).toBe(404);
    await prunePhotos(s.env as never);
    expect(s.objects.size).toBe(0);
  });
  it('R2 failure leaves no readable photo and frees active storage without refunding daily usage', async () => {
    const s = setup();
    s.env.UPLOADS.put = async () => {
      throw new Error('storage offline');
    };
    expect((await s.upload()).status).toBe(500);
    expect(s.db.prepare('SELECT state FROM photos').get()).toEqual(
      expect.objectContaining({ state: 'deleted' }),
    );
    expect(s.objects.size).toBe(0);
  });
});

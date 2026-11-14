import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.js';
import { Photos, preparePhoto } from './photos.js';

function browser(sizes = [50_000]) {
  const close = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width: 4032, height: 3024, close }),
  );
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillRect: vi.fn(), drawImage, fillStyle: '' }),
    toBlob: vi.fn((callback: (blob: Blob) => void) =>
      callback(new Blob([new Uint8Array(sizes.shift() ?? 50_000)], { type: 'image/jpeg' })),
    ),
  };
  vi.stubGlobal('document', { createElement: () => canvas });
  return { canvas, close, drawImage };
}
const source = () => new Blob(['original-exif-photo'], { type: 'image/jpeg' });
afterEach(() => vi.unstubAllGlobals());

describe('small temporary photos SDK', () => {
  it('resizes camera photos to 640px, re-encodes, and releases decoded image memory', async () => {
    const b = browser([150_000, 75_000]);
    const output = await preparePhoto(source());
    expect([b.canvas.width, b.canvas.height]).toEqual([640, 480]);
    expect(output.type).toBe('image/jpeg');
    expect(output.size).toBe(75_000);
    expect(b.canvas.toBlob).toHaveBeenCalledTimes(2);
    expect(b.close).toHaveBeenCalled();
  });
  it('rejects images that remain too large instead of sending them', async () => {
    const b = browser([300_000, 300_000, 300_000, 300_000]);
    await expect(preparePhoto(source())).rejects.toThrow(/small enough/);
    expect(b.close).toHaveBeenCalled();
  });
  it('private by default; explicit public uploads carry only compressed image bytes', async () => {
    browser();
    const fetch = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: 'p1', url: '/v1/apps/wood/photos/p1' }), {
          status: 201,
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const photos = new Photos('wood', 'https://api.example', { token: 'tok' } as Auth);
    const first = await photos.upload(source());
    expect(fetch.mock.calls[0]![0]).toContain('visibility=private');
    expect(first.url).toBe('https://api.example/v1/apps/wood/photos/p1');
    const body = fetch.mock.calls[0]![1].body as Blob;
    expect(body.size).toBe(50_000);
    expect(body).not.toBe(source());
    await photos.upload(source(), { visibility: 'public' });
    expect(fetch.mock.calls[1]![0]).toContain('visibility=public');
  });
  it('refuses signed-out uploads before decoding; handles expired sessions', async () => {
    const b = browser();
    const auth = { token: null, handleUnauthorized: vi.fn() };
    const photos = new Photos('wood', 'https://api.example', auth as unknown as Auth);
    await expect(photos.upload(source())).rejects.toThrow('Not signed in');
    expect(b.drawImage).not.toHaveBeenCalled();
    auth.token = 'expired' as never;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    );
    await expect(photos.list()).rejects.toThrow('Not signed in');
    expect(auth.handleUnauthorized).toHaveBeenCalledWith('expired');
  });
});

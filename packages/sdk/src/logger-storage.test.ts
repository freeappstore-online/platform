// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.js';
import { initApp } from './index.js';
import { Logger } from './logger.js';

const auth = { token: 'test-token' } as unknown as Auth;
const KEY = 'fas_logs:app1';

describe('Logger with unavailable storage (#341)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes the SDK and keeps logging in memory when the storage getter throws', () => {
    const getter = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });

    const app = initApp({ appId: 'app1', apiBase: 'https://api.test' });
    try {
      expect(getter).toHaveBeenCalled();
      expect(app.auth.token).toBeNull();
      expect(() => app.log.info('public browsing')).not.toThrow();
      expect(app.log.entries().map((entry) => entry.message)).toEqual(['public browsing']);
      expect(() => app.log.clear()).not.toThrow();
      expect(app.log.entries()).toEqual([]);
      app.log.warn('still available');
      expect(app.log.entries().map((entry) => entry.message)).toEqual(['still available']);
    } finally {
      app.log.destroy();
    }
  });

  it('clears memory even when storage removal throws', () => {
    const log = new Logger('app1', 'https://api.test', auth);
    try {
      log.info('before clear');
      vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
        throw new DOMException('Storage blocked', 'SecurityError');
      });
      expect(() => log.clear()).not.toThrow();
      expect(log.entries()).toEqual([]);
    } finally {
      log.destroy();
    }
  });
});

// #280: entries persisted across page loads upload once, not on every load.
describe('Logger across page loads', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const sent = () =>
    fetchMock.mock.calls.flatMap((c) =>
      (JSON.parse((c[1] as RequestInit).body as string).entries as { message: string }[]).map(
        (e) => e.message,
      ),
    );
  const page = () => new Logger('app1', 'https://api.test', auth);

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not re-upload entries a previous page already uploaded', async () => {
    const first = page();
    first.info('a');
    first.info('b');
    await first.flush();
    first.destroy();

    const second = page(); // reload: restores a, b from storage
    expect(second.entries().map((e) => e.message)).toEqual(['b', 'a']); // newest first
    await second.flush();
    second.info('c');
    await second.flush();
    second.destroy();

    expect(sent()).toEqual(['a', 'b', 'c']);
  });

  it('uploads entries a previous page logged but never sent (e.g. a crash)', async () => {
    const first = page();
    first.info('sent');
    await first.flush();
    first.error('crashed before upload');
    first.destroy();

    const second = page();
    await second.flush();
    second.destroy();

    expect(sent()).toEqual(['sent', 'crashed before upload']);
  });

  it('reads the old bare-array format as not uploaded', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([{ ts: 1, level: 'info', category: 'app', message: 'old' }]),
    );
    const p = page();
    await p.flush();
    await p.flush();
    p.destroy();
    expect(sent()).toEqual(['old']);
  });
});

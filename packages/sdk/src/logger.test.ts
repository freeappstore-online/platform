import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.js';
import { Logger } from './logger.js';

// Minimal Auth stub — Logger only reads `.token`.
const auth = { token: 'test-token' } as unknown as Auth;

function bodies(fetchMock: ReturnType<typeof vi.fn>): Array<{ entries: unknown[] }> {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

describe('Logger upload watermark', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads each entry exactly once across repeated flushes', async () => {
    const log = new Logger('app1', 'https://api.test', auth);
    log.clear(); // reset watermark + any restored entries from storage

    log.info('a');
    log.info('b');
    await log.flush();

    // Second flush with no new entries must NOT re-send the previous batch.
    await log.flush();

    log.info('c');
    await log.flush();

    log.destroy();

    const sent = bodies(fetchMock).map((b) =>
      (b.entries as { message: string }[]).map((e) => e.message),
    );
    // First flush sends [a,b]; empty flush sends nothing; third sends [c] only.
    expect(sent).toEqual([['a', 'b'], ['c']]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not advance the watermark when the upload fails (retries next time)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const log = new Logger('app2', 'https://api.test', auth);
    log.clear();

    log.info('x');
    await log.flush(); // 500 → watermark stays
    await log.flush(); // retry → 204, succeeds

    log.destroy();

    const sent = bodies(fetchMock).map((b) =>
      (b.entries as { message: string }[]).map((e) => e.message),
    );
    expect(sent).toEqual([['x'], ['x']]); // re-sent once after failure, then drained
    // A third flush sends nothing more.
    await log.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not skip entries when the full buffer evicts during an upload', async () => {
    const log = new Logger('app3', 'https://api.test', auth);
    log.clear();
    for (let i = 0; i < 200; i++) log.info(`m${i}`); // buffer at its 200-entry cap

    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => (release = () => r(new Response(null, { status: 204 })))),
    );
    const first = log.flush(); // sends m0..m49
    for (let i = 200; i < 210; i++) log.info(`m${i}`); // evicts m0..m9 mid-upload
    release();
    await first;
    await log.flush();
    log.destroy();

    const second = (bodies(fetchMock)[1]!.entries as { message: string }[]).map((e) => e.message);
    expect(second[0]).toBe('m50');
  });
});

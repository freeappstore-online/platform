import { afterEach, describe, expect, it, vi } from 'vitest';

const opts = {
  cacheKey: 'app:API',
  tokenUrl: 'https://auth.example/token',
  clientId: 'id',
  clientSecret: 'secret',
};
const token = (accessToken: string) =>
  new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), { status: 200 });

/** A fresh module per test: the token cache is module state. */
async function load() {
  vi.resetModules();
  return (await import('./proxy-oauth2.js')).getOAuth2Token;
}
afterEach(() => vi.unstubAllGlobals());

describe('getOAuth2Token', () => {
  it('gives each refresh made while another is in flight its own request (1101, #641)', async () => {
    const releases: ((r: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const getOAuth2Token = await load();
    const a = getOAuth2Token(opts);
    const b = getOAuth2Token(opts);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releases[0]?.(token('t1'));
    releases[1]?.(token('t2'));
    expect(await Promise.all([a, b])).toEqual(['t1', 't2']);
  });

  it('serves a cached token and retries after a failed refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('no', { status: 500 }))
      .mockResolvedValue(token('t1'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const getOAuth2Token = await load();
    await expect(getOAuth2Token(opts)).rejects.toThrow('OAuth2 token request failed (500)');
    expect(await getOAuth2Token(opts)).toBe('t1');
    expect(await getOAuth2Token(opts)).toBe('t1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps separate tokens per tokenUrl and drops them when credentials rotate (#769)', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => token(`t${++n}`));
    vi.stubGlobal('fetch', fetchMock);
    const getOAuth2Token = await load();
    expect(await getOAuth2Token(opts)).toBe('t1');
    const otherProvider = { ...opts, tokenUrl: 'https://other.example/token' };
    expect(await getOAuth2Token(otherProvider)).toBe('t2');
    expect(await getOAuth2Token(opts)).toBe('t1');
    expect(await getOAuth2Token(otherProvider)).toBe('t2');
    expect(await getOAuth2Token({ ...opts, clientSecret: 'rotated' })).toBe('t3');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

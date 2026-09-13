import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkNoCommittedArtifacts } from '../checks/no-committed-artifacts.js';
import { githubTreeSource } from './github-tree-source.js';

type FetchMock = ReturnType<typeof vi.fn>;

function treeResponse(tree: Array<{ path: string; type: string }>, truncated = false): Response {
  return new Response(JSON.stringify({ sha: 'abc', tree, truncated }), { status: 200 });
}

describe('githubTreeSource', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists blob paths only, excluding tree (directory) entries', async () => {
    (fetch as unknown as FetchMock).mockResolvedValue(
      treeResponse([
        { path: 'web', type: 'tree' },
        { path: 'web/dist', type: 'tree' },
        { path: 'web/dist/index.html', type: 'blob' },
        { path: 'web/src/App.tsx', type: 'blob' },
        { path: 'vendor/sub', type: 'commit' },
      ]),
    );
    const tracked = await githubTreeSource('freeappstore-online', 'tip').listTracked!();
    expect(tracked).toEqual(['web/dist/index.html', 'web/src/App.tsx']);
  });

  it('requests the recursive tree for the given repo, unauthenticated', async () => {
    (fetch as unknown as FetchMock).mockResolvedValue(treeResponse([]));
    await githubTreeSource('freeappstore-online', 'tip').listTracked!();
    const [url, init] = (fetch as unknown as FetchMock).mock.calls[0]!;
    expect(url).toBe(
      'https://api.github.com/repos/freeappstore-online/tip/git/trees/HEAD?recursive=1',
    );
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.headers['User-Agent']).toBeTruthy();
  });

  it.each([404, 403, 429, 500])('returns null on HTTP %i', async (status) => {
    (fetch as unknown as FetchMock).mockResolvedValue(new Response('{"message":"x"}', { status }));
    expect(await githubTreeSource('o', 'r').listTracked!()).toBeNull();
  });

  it('returns null for a truncated tree rather than a partial list', async () => {
    (fetch as unknown as FetchMock).mockResolvedValue(
      treeResponse([{ path: 'README.md', type: 'blob' }], true),
    );
    expect(await githubTreeSource('o', 'r').listTracked!()).toBeNull();
  });

  it('returns null when fetch throws (network error / timeout)', async () => {
    (fetch as unknown as FetchMock).mockRejectedValue(new Error('ECONNRESET'));
    expect(await githubTreeSource('o', 'r').listTracked!()).toBeNull();
  });

  it('fetches once per source even when called concurrently', async () => {
    (fetch as unknown as FetchMock).mockImplementation(async () => treeResponse([]));
    const src = githubTreeSource('o', 'r');
    await Promise.all([src.listTracked!(), src.listTracked!()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('drives checkNoCommittedArtifacts: counts files, not directories', async () => {
    (fetch as unknown as FetchMock).mockResolvedValue(
      treeResponse([
        { path: 'web/dist', type: 'tree' },
        { path: 'web/dist/assets', type: 'tree' },
        { path: 'web/dist/index.html', type: 'blob' },
        { path: 'web/dist/assets/index.js', type: 'blob' },
      ]),
    );
    const r = await checkNoCommittedArtifacts(githubTreeSource('o', 'r'));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/^2 tracked artifact file/);
  });

  it('drives checkNoCommittedArtifacts to warn (not pass) when the tree is unavailable', async () => {
    (fetch as unknown as FetchMock).mockResolvedValue(new Response('', { status: 403 }));
    const r = await checkNoCommittedArtifacts(githubTreeSource('o', 'r'));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/rate-limited/);
  });
});

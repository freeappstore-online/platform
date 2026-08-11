import { describe, expect, it } from 'vitest';
import type { FileSource } from '../lib/file-source.js';
import { mapFileSource } from '../lib/file-source.js';
import { checkNoCommittedArtifacts } from './no-committed-artifacts.js';

/** A FileSource whose only meaningful capability is listTracked(). */
function trackedSource(paths: string[] | null): FileSource {
  return {
    async *list() {
      /* not used by this check */
    },
    async read() {
      return null;
    },
    async listTracked() {
      return paths;
    },
  };
}

describe('checkNoCommittedArtifacts', () => {
  it('passes on a clean repo', async () => {
    const r = await checkNoCommittedArtifacts(
      trackedSource(['package.json', 'web/src/App.tsx', '.gitignore', 'README.md']),
    );
    expect(r.status).toBe('pass');
  });

  it('fails when node_modules is tracked', async () => {
    const r = await checkNoCommittedArtifacts(
      trackedSource([
        'package.json',
        'node_modules/react/index.js',
        'node_modules/react/package.json',
      ]),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/node_modules\//);
    expect(r.detail).toMatch(/2 tracked artifact file/);
  });

  it('fails on nested node_modules, not just root', async () => {
    const r = await checkNoCommittedArtifacts(
      trackedSource(['web/node_modules/left-pad/index.js']),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/node_modules\//);
  });

  it('fails on tracked dist/ and .DS_Store', async () => {
    const r = await checkNoCommittedArtifacts(
      trackedSource(['dist/index.js', '.DS_Store', 'web/.DS_Store']),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/dist\//);
    expect(r.detail).toMatch(/\.DS_Store/);
  });

  it('summarises instead of listing thousands of paths', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => `node_modules/pkg/file${i}.js`);
    const r = await checkNoCommittedArtifacts(trackedSource(many));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/3000 tracked artifact file/);
    expect(r.detail).toMatch(/\+2995 more/);
    // The whole point of summarising: the message stays human-sized.
    expect(r.detail.length).toBeLessThan(500);
  });

  it('does not flag paths that merely resemble artifact names', async () => {
    const r = await checkNoCommittedArtifacts(
      trackedSource([
        'src/node_modules_helper.ts', // substring, not a path segment
        'docs/distribution.md', // starts with "dist"
        'src/dist-utils.ts',
        'assets/DS_Store.png', // no leading dot
      ]),
    );
    expect(r.status).toBe('pass');
  });

  it('warns (never fails) when the source has no VCS view', async () => {
    const r = await checkNoCommittedArtifacts(mapFileSource(new Map([['package.json', '{}']])));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/no version-control view/);
  });

  it('warns when listTracked returns null (not a git repo)', async () => {
    const r = await checkNoCommittedArtifacts(trackedSource(null));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/not a git repository/);
  });
});

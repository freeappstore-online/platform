import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertFreeAppStoreProject } from './publish.js';

describe('assertFreeAppStoreProject — cross-store guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'store-guard-'));
    mkdirSync(join(dir, 'web'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('allows a real FreeAppStore app (uses @freeappstore/sdk)', async () => {
    writeFileSync(
      join(dir, 'web', 'package.json'),
      JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.14.0' } }),
    );
    expect(await assertFreeAppStoreProject(dir)).toBeNull();
  });

  it('rejects a FreeGameStore game by its SDK dependency (the dodge-drop case)', async () => {
    writeFileSync(
      join(dir, 'web', 'package.json'),
      JSON.stringify({ dependencies: { '@freegamestore/games': '^0.16.0' } }),
    );
    const err = await assertFreeAppStoreProject(dir);
    expect(err).toContain('fgs publish');
  });

  it('rejects a project whose deploy.yml targets the fgs-games bucket', async () => {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'workflows', 'deploy.yml'),
      'aws s3 sync ./web/dist "s3://fgs-games/games/foo/"',
    );
    const err = await assertFreeAppStoreProject(dir);
    expect(err).toContain('fgs publish');
  });

  it('is silent (null) when there is no project', async () => {
    expect(await assertFreeAppStoreProject(dir)).toBeNull();
  });
});

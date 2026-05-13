import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoTracking } from './no-tracking.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
  await mkdir(join(dir, 'web'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkNoTracking', () => {
  it('passes when no tracking strings anywhere', async () => {
    await writeFile(join(dir, 'web', 'app.ts'), 'export const x = 1;');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('fails on google-analytics in source', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<script src="https://www.google-analytics.com/analytics.js"></script>',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/google-analytics/);
  });

  it('fails on plausible / posthog as deps even though those are privacy-respecting', async () => {
    // FreeAppStore policy is *no* analytics, even the privacy-respecting ones.
    await writeFile(join(dir, 'web', 'package.json'), '{"dependencies":{"posthog-js":"1.0.0"}}');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/posthog/);
  });

  it('does not scan dist or node_modules (skipped by walk)', async () => {
    await mkdir(join(dir, 'node_modules', 'posthog-js'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'posthog-js', 'index.js'), '// posthog stuff');
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'bundle.js'), 'amplitude.track("x")');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });
});

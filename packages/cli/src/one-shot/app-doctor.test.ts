import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDoctor } from './app-doctor.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fas-app-doctor-'));
  roots.push(root);
  const files = {
    'fas.json': JSON.stringify({
      appId: 'carry-kit',
      applicationRoot: 'client',
      outputPath: 'release/site',
      buildCommand: 'node build.mjs client',
    }),
    'package.json': JSON.stringify({
      name: 'carry-kit',
      packageManager: 'pnpm@10.30.3',
      scripts: { typecheck: 'node verify.mjs', test: 'node verify.mjs', build: 'node wrong.mjs' },
    }),
    'client/package.json': JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.16.37' } }),
    'client/node_modules/@freeappstore/sdk/package.json': JSON.stringify({ version: '0.16.37' }),
    'client/index.html': '<script type="module" src="./app.js"></script>',
    'client/app.js': "initApp({ appId: 'carry-kit' });",
    'verify.mjs': "import fs from 'node:fs';fs.writeFileSync('verified', 'yes');",
    'wrong.mjs': "throw new Error('Wrong build selected');",
    'build.mjs':
      "import fs from 'node:fs';fs.mkdirSync('release/site', {recursive:true});fs.writeFileSync('release/site/index.html', '<script src=\"./app.js\"></script>');fs.writeFileSync('release/site/app.js', 'console.log(\"Ready\")');",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('app-oriented doctor', () => {
  it('inspects a custom standalone layout without network or executing app scripts', async () => {
    const fetch = vi.fn(() => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetch);
    const root = await fixture();
    const report = await appDoctor({ root, offline: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(report.mode).toBe('local');
    expect(report.target?.outputPath).toBe('release/site');
    expect(report.sdk).toEqual({ declared: '^0.16.37', resolved: '0.16.37' });
    expect(report.cliVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.lock).toMatchObject({ present: false, freshness: 'not-checked' });
    expect(report.capabilities).toEqual({});
    expect(report.stages.every((s) => s.status === 'not-run')).toBe(true);
    await expect(readFile(join(root, 'verified'))).rejects.toThrow();
    expect(
      report.checks.some((c) => ['Signed in', 'API reachable', 'Config file'].includes(c.name)),
    ).toBe(false);
  });
  it('explicit verification uses the declared build and never claims browser/push/deployment success', async () => {
    const root = await fixture();
    const report = await appDoctor({ root, offline: true, verify: true, artifact: true });
    expect(report.stages.slice(0, 4).map((s) => s.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
    expect(report.stages.slice(4).every((s) => s.status === 'not-run')).toBe(true);
    expect(await readFile(join(root, 'verified'), 'utf8')).toBe('yes');
    expect(report.checks.find((c) => c.name === 'Artifact icon assets')?.status).toBe('warn');
  }, 20_000);
  it('reports installed SDK mismatch and optional capability versions without requiring capabilities', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client/node_modules/@freeappstore/sdk/package.json'),
      JSON.stringify({ version: '0.15.0' }),
    );
    await writeFile(
      join(root, '.fas-capabilities.json'),
      JSON.stringify({ capabilities: { persistence: { version: '1.0.0' } } }),
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    const report = await appDoctor({ root, offline: true });
    expect(report.checks.find((c) => c.name === 'SDK dependency')?.status).toBe('fail');
    expect(report.capabilities).toEqual({ persistence: '1.0.0' });
    expect(report.lock).toMatchObject({
      present: true,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      freshness: 'not-checked',
    });
  });
  it('reports failed scripts, missing scripts and missing artifacts truthfully', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'carry-kit',
        packageManager: 'pnpm@10.30.3',
        scripts: { test: 'node wrong.mjs' },
      }),
    );
    const report = await appDoctor({ root, offline: true, verify: true });
    expect(report.stages.find((s) => s.name === 'typecheck')?.status).toBe('not-configured');
    expect(report.stages.find((s) => s.name === 'tests')?.status).toBe('failed');
    await rm(join(root, 'release'), { recursive: true, force: true });
    const missing = await appDoctor({ root, offline: true, artifact: true });
    expect(missing.stages.find((s) => s.name === 'artifact')?.status).toBe('failed');
  }, 20_000);
  it('does not echo dependency URLs, arbitrary config fragments or network error credentials', async () => {
    const root = await fixture();
    const secret = 'SENSITIVE_SENTINEL';
    await writeFile(
      join(root, 'client/package.json'),
      JSON.stringify({
        dependencies: { '@freeappstore/sdk': `https://user:${secret}@example.test/pkg` },
      }),
    );
    await writeFile(
      join(root, '.fas-capabilities.json'),
      JSON.stringify({ capabilities: { media: { version: secret } } }),
    );
    await writeFile(join(root, 'fas.json'), `{"password":"${secret}" INVALID`);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`https://user:${secret}@example.test`)),
    );
    const report = await appDoctor({ root });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.checks.find((c) => c.name === 'Build/deploy target')?.status).toBe('fail');
  });
});

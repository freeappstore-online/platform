import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { satisfies } from 'semver';
import { afterEach, expect, it } from 'vitest';
import {
  type Capability,
  installCapabilities,
  normalizeFreshCapabilityPackages,
  registry,
  resolveCapabilities,
} from './capabilities.js';

const roots: string[] = [];
async function app() {
  const root = await mkdtemp(join(tmpdir(), 'fas-cap-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'user.txt'), 'keep');
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const cap = (id: string, dependencies = {}): Capability => ({
  id,
  version: '1.0.0',
  dependencies,
  environment: 'browser',
  files: { [`${id}.ts`]: id },
  configChanges: [],
  validate: () => true,
});

it('resolves dependencies before dependents and rejects incompatible versions and cycles', () => {
  const source = { a: cap('a', { b: '1.0.0' }), b: cap('b') };
  expect(resolveCapabilities(['a', 'b'], source).map((c) => c.id)).toEqual(['b', 'a']);
  expect(() =>
    resolveCapabilities(['a'], { ...source, b: { ...source.b, version: '2.0.0' } }),
  ).toThrow('incompatible');
  expect(() => resolveCapabilities(['a'], { ...source, b: cap('b', { a: '1.0.0' }) })).toThrow(
    'cycle',
  );
});
it('describes the explicit room-restricted backend data model accurately', () => {
  const cloud = registry['cloud-data'];
  const persistence = registry.persistence;
  expect(cloud?.metadata?.['room-restricted']).toBe('backend-http:data-rooms');
  expect(cloud?.files['fas-capabilities/cloud-data.md']).toContain('docs/data-rooms.md');
  expect(cloud?.files['fas-capabilities/cloud-data.md']).toContain(
    'Realtime rooms are broadcast channels',
  );
  expect(persistence?.metadata?.roomRestricted).toBe('backend-http:data-rooms');
});
it('defines optional realtime and media recipes with bounded lifecycle and permission behavior', () => {
  const realtime = registry.realtime;
  const media = registry.media;
  expect(realtime?.metadata).toMatchObject({
    transport: 'sdk-rooms:websocket-fanout',
    access: 'ephemeral-broadcast-not-private',
    transfer: 'p2p-app-owned',
  });
  expect(realtime?.files['fas-capabilities/realtime.ts']).toContain('signal?.addEventListener');
  expect(realtime?.files['fas-capabilities/realtime.ts']).toContain('room.close()');
  expect(realtime?.files['fas-capabilities/realtime.md']).toContain('checksum and flow-control');
  expect(media?.metadata).toMatchObject({
    permissions: 'user-gesture-only,no-persistent-grants',
    mobileTabCapture: 'unsupported',
  });
  expect(media?.packages?.[0]).toMatchObject({
    name: '@freeappstore/sdk',
    range: '>=0.16.26',
  });
  expect(media?.files['fas-capabilities/media.ts']).toContain("from '@freeappstore/sdk/media'");
  expect(media?.files['fas-capabilities/media.ts']).toContain('stopRecording');
  expect(media?.files['fas-capabilities/media.md']).toContain('Permission denial');
  expect(media?.files['fas-capabilities/media.md']).toContain('existing file');
});
it('installs realtime and media independently without external package or service setup', async () => {
  const root = await app();
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.16.26' } }),
  );
  await installCapabilities(root, ['realtime', 'media']);
  expect(await readFile(join(root, 'fas-capabilities/realtime.ts'), 'utf8')).toContain(
    'room.close()',
  );
  expect(await readFile(join(root, 'fas-capabilities/media.ts'), 'utf8')).toContain(
    'exportRecording',
  );
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual({
    dependencies: { '@freeappstore/sdk': '^0.16.26' },
  });
  expect(await installCapabilities(root, ['realtime', 'media'])).toEqual(['No changes.']);
});
it('requires the SDK release with permanent-close and media helpers before writing either recipe', async () => {
  const root = await app();
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.16.25' } }),
  );
  await expect(installCapabilities(root, ['realtime', 'media'])).rejects.toThrow(
    '@freeappstore/sdk >=0.16.26',
  );
  await expect(readFile(join(root, 'fas-capabilities/realtime.ts'))).rejects.toThrow();
  await expect(readFile(join(root, 'fas-capabilities/media.ts'))).rejects.toThrow();
});
it('adopts existing apps, previews without writes, installs idempotently and preserves unrelated files', async () => {
  const root = await app();
  expect((await installCapabilities(root, ['connectivity'], { dryRun: true })).join()).toContain(
    'CREATE',
  );
  await expect(readFile(join(root, '.fas-capabilities.json'))).rejects.toThrow();
  await installCapabilities(root, ['connectivity']);
  expect(await installCapabilities(root, ['connectivity'])).toEqual(['No changes.']);
  expect(await readFile(join(root, 'user.txt'), 'utf8')).toBe('keep');
});
it('rejects developer edits before making any changes', async () => {
  const root = await app();
  await installCapabilities(root, ['connectivity']);
  const file = join(root, 'fas-capabilities/connectivity.ts');
  await writeFile(file, 'developer code');
  await expect(installCapabilities(root, ['connectivity'])).rejects.toThrow('conflict');
  expect(await readFile(file, 'utf8')).toBe('developer code');
});
it('retries safely after partial failure without silently adopting different bytes', async () => {
  const root = await app();
  const source = { a: cap('a'), b: cap('b') };
  let count = 0;
  await expect(
    installCapabilities(root, ['a', 'b'], {
      source,
      write: (async (...args: Parameters<typeof writeFile>) => {
        if (++count === 2) throw new Error('disk failure');
        return writeFile(...args);
      }) as typeof writeFile,
    }),
  ).rejects.toThrow('disk failure');
  await installCapabilities(root, ['a', 'b'], { source });
  expect(await installCapabilities(root, ['a', 'b'], { source })).toEqual(['No changes.']);
});
it('requires explicit updates and retains removed files', async () => {
  const root = await app();
  await installCapabilities(root, ['a'], { source: { a: cap('a') } });
  const a = { ...cap('a'), version: '2.0.0', files: { 'new.ts': 'new' } };
  await expect(installCapabilities(root, ['a'], { source: { a } })).rejects.toThrow('--update');
  await installCapabilities(root, ['a'], { source: { a }, update: true });
  expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('a');
});
it('rejects unowned collisions, overlapping ownership and traversal', async () => {
  const root = await app();
  await writeFile(join(root, 'a.ts'), 'mine');
  await expect(installCapabilities(root, ['a'], { source: { a: cap('a') } })).rejects.toThrow(
    'conflict',
  );
  await expect(
    installCapabilities(root, ['x'], {
      source: { x: { ...cap('x'), files: { '../escape': 'bad' } } },
    }),
  ).rejects.toThrow('Unsafe');
  const a = cap('a');
  const b = { ...cap('b'), files: a.files };
  await rm(join(root, 'a.ts'));
  await expect(installCapabilities(root, ['a', 'b'], { source: { a, b } })).rejects.toThrow(
    'Multiple',
  );
  await expect(readFile(join(root, 'a.ts'))).rejects.toThrow();
  expect(registry.connectivity?.environment).toBe('browser');
});

it('installs persistence at init and later without touching saved data or edited files', async () => {
  const root = await app();
  await writeFile(join(root, 'notes.json'), '{"keep":true}');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.16.19' } }),
  );
  const plan = await installCapabilities(root, ['persistence']);
  expect(plan.join('\n')).toContain('CREATE');
  expect(plan.join('\n')).toContain('device-only');
  expect(await readFile(join(root, 'notes.json'), 'utf8')).toBe('{"keep":true}');
  expect(await installCapabilities(root, ['persistence'])).toEqual(['No changes.']);
  const file = join(root, 'fas-capabilities/persistence.ts');
  await writeFile(file, 'app edited persistence');
  await expect(installCapabilities(root, ['persistence'])).rejects.toThrow('conflict');
  expect(await readFile(file, 'utf8')).toBe('app edited persistence');
  expect(await readFile(join(root, 'notes.json'), 'utf8')).toBe('{"keep":true}');
  expect(await readFile(join(root, 'user.txt'), 'utf8')).toBe('keep');
});

it('installs backup at init and later without deleting saved data or edited files', async () => {
  const root = await app();
  await writeFile(join(root, 'notes.json'), '{"keep":true}');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.16.21' } }),
  );
  const plan = await installCapabilities(root, ['backup']);
  expect(plan.join('\n')).toContain('CREATE');
  expect(plan.join('\n')).toContain('fas-capabilities/persistence.ts');
  expect(plan.join('\n')).toContain('fas-capabilities/backup.ts');
  expect(plan.join('\n')).toContain('merge');
  expect(await readFile(join(root, 'notes.json'), 'utf8')).toBe('{"keep":true}');
  expect(await installCapabilities(root, ['backup'])).toEqual(['No changes.']);
  const file = join(root, 'fas-capabilities/backup.ts');
  await writeFile(file, 'app edited backup');
  await expect(installCapabilities(root, ['backup'])).rejects.toThrow('conflict');
  expect(await readFile(file, 'utf8')).toBe('app edited backup');
  expect(await readFile(join(root, 'notes.json'), 'utf8')).toBe('{"keep":true}');
  expect(await readFile(join(root, 'user.txt'), 'utf8')).toBe('keep');
});

it('requires the published backup SDK before writing capability files', async () => {
  const root = await app();
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.16.20' } }),
  );
  await expect(installCapabilities(root, ['backup'])).rejects.toThrow(
    'requires @freeappstore/sdk >=0.16.21',
  );
  await expect(readFile(join(root, 'fas-capabilities/backup.ts'))).rejects.toThrow();
  await expect(readFile(join(root, 'fas-capabilities/persistence.ts'))).rejects.toThrow();
});

it('normalizes stale SDK ranges only in a fresh template for the selected capabilities', async () => {
  const root = await app();
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(
    join(root, 'web/package.json'),
    JSON.stringify({
      dependencies: { '@freeappstore/sdk': '^0.16.12', react: '^19.0.0' },
      devDependencies: { 'vite-plugin-pwa': '^1.3.0' },
    }),
  );

  await normalizeFreshCapabilityPackages(root, ['pwa']);

  const web = JSON.parse(await readFile(join(root, 'web/package.json'), 'utf8'));
  const sdkRange = web.dependencies['@freeappstore/sdk'];
  expect(sdkRange).toBe('^0.16.15');
  expect(satisfies('0.16.21', sdkRange)).toBe(true);
  expect(satisfies('1.0.0', sdkRange)).toBe(false);
  expect(web.dependencies.react).toBe('^19.0.0');
  expect(web.devDependencies['vite-plugin-pwa']).toBe('^1.3.0');
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe('{}');
});

it('prepares root and web SDK dependencies for a fresh backup preset', async () => {
  const root = await app();
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(
    join(root, 'web/package.json'),
    JSON.stringify({
      dependencies: { '@freeappstore/sdk': '^0.16.12', react: '^19.0.0' },
      devDependencies: { 'vite-plugin-pwa': '^1.3.0' },
    }),
  );

  await normalizeFreshCapabilityPackages(root, ['backup', 'pwa']);
  const plan = await installCapabilities(root, ['backup', 'pwa']);

  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const webManifest = JSON.parse(await readFile(join(root, 'web/package.json'), 'utf8'));
  expect(rootManifest.dependencies['@freeappstore/sdk']).toBe('^0.16.21');
  expect(webManifest.dependencies['@freeappstore/sdk']).toBe('^0.16.21');
  expect(satisfies('0.16.30', rootManifest.dependencies['@freeappstore/sdk'])).toBe(true);
  expect(satisfies('1.0.0', rootManifest.dependencies['@freeappstore/sdk'])).toBe(false);
  expect(plan.join('\n')).toContain('fas-capabilities/persistence.ts');
  expect(plan.join('\n')).toContain('fas-capabilities/backup.ts');
  expect(plan.join('\n')).toContain('web/src/fas-capabilities/pwa.ts');
});

it('retries an interrupted version update and detects edits afterwards', async () => {
  const root = await app();
  await installCapabilities(root, ['a'], { source: { a: cap('a') } });
  const source = { a: { ...cap('a'), version: '2.0.0', files: { 'a.ts': 'updated' } } };
  await expect(
    installCapabilities(root, ['a'], {
      source,
      update: true,
      write: (async (path: string, content: string) => {
        if (path.endsWith('.json')) throw new Error('interrupted');
        await writeFile(path, content);
      }) as typeof writeFile,
    }),
  ).rejects.toThrow('interrupted');
  await installCapabilities(root, ['a'], { source, update: true });
  expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('updated');
  await writeFile(join(root, 'a.ts'), 'edited');
  await expect(installCapabilities(root, ['a'], { source, update: true })).rejects.toThrow(
    'conflict',
  );
});

it.each([
  undefined,
  '0.16.14',
  '^0.16.14',
  '*',
  '>=0.15.0',
  'workspace:*',
  'workspace:^0.16.19',
  'file:../sdk',
  '0.17.0-beta.1',
])('rejects unproven persistence prerequisite %s before any writes', async (version) => {
  const root = await app();
  const pkg = JSON.stringify({ dependencies: version ? { '@freeappstore/sdk': version } : {} });
  await writeFile(join(root, 'package.json'), pkg);
  await writeFile(join(root, 'pnpm-lock.yaml'), 'custom lockfile');
  const before = await readdir(root);
  const preview = await installCapabilities(root, ['connectivity', 'persistence'], {
    dryRun: true,
  });
  expect(preview.join('\n')).toContain('INCOMPLETE');
  expect(preview.join('\n')).toContain('@freeappstore/sdk >=0.16.18');
  await expect(installCapabilities(root, ['connectivity', 'persistence'])).rejects.toThrow(
    'prerequisites unmet',
  );
  expect(await readdir(root)).toEqual(before);
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(pkg);
  expect(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe('custom lockfile');
});

it.each(['0.16.18', '^0.16.18', '~0.16.19', '>=0.16.18 <0.17.0', '^0.16.19 || ^0.17.0'])(
  'accepts compatible range %s without changing package choices',
  async (version) => {
    const root = await app();
    const pkg = JSON.stringify({ dependencies: { '@freeappstore/sdk': version } });
    await writeFile(join(root, 'package.json'), pkg);
    expect(
      (await installCapabilities(root, ['persistence'], { dryRun: true })).join('\n'),
    ).toContain('PREREQUISITE');
    await expect(readFile(join(root, '.fas-capabilities.json'))).rejects.toThrow();
    await installCapabilities(root, ['persistence']);
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(pkg);
    await writeFile(join(root, 'package.json'), '{}');
    const manifest = await readFile(join(root, '.fas-capabilities.json'), 'utf8');
    await expect(installCapabilities(root, ['persistence'])).rejects.toThrow('prerequisites');
    expect(await readFile(join(root, '.fas-capabilities.json'), 'utf8')).toBe(manifest);
  },
);

it('checks PWA prerequisites in web/package.json rather than accepting unrelated root dependencies', async () => {
  const root = await app();
  const dependencies = { '@freeappstore/sdk': '^0.16.19', 'vite-plugin-pwa': '^1.3.0' };
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies }));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/package.json'), '{}');
  await expect(installCapabilities(root, ['pwa'])).rejects.toThrow('web/package.json');
  await writeFile(
    join(root, 'web/package.json'),
    JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.16.19' } }),
  );
  await expect(installCapabilities(root, ['pwa'])).rejects.toThrow('vite-plugin-pwa');
  await writeFile(
    join(root, 'web/package.json'),
    JSON.stringify({
      dependencies: { '@freeappstore/sdk': '^0.16.19' },
      devDependencies: { 'vite-plugin-pwa': '^1.3.0' },
    }),
  );
  await installCapabilities(root, ['pwa']);
  expect(await installCapabilities(root, ['pwa'])).toEqual(['No changes.']);
});

it('requires root SDK for a root persistence import even when web has SDK', async () => {
  const root = await app();
  await mkdir(join(root, 'web'));
  await writeFile(
    join(root, 'web/package.json'),
    JSON.stringify({ dependencies: { '@freeappstore/sdk': '^0.16.19' } }),
  );
  await expect(installCapabilities(root, ['persistence'])).rejects.toThrow('package.json requires');
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  type Capability,
  installCapabilities,
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

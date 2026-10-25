import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('npm publishing dependency order', () => {
  it('publishes every runtime workspace dependency before its consumer', () => {
    const loop = /for PKG in ([a-z -]+); do/.exec(read('.github/workflows/publish.yml'));
    expect(loop).not.toBeNull();
    const order = loop![1]!.trim().split(/\s+/);
    const manifests = order.map(
      (dir) =>
        JSON.parse(read(`packages/${dir}/package.json`)) as {
          name: string;
          dependencies?: Record<string, string>;
        },
    );
    const positions = new Map(manifests.map((manifest, index) => [manifest.name, index]));
    for (const [index, manifest] of manifests.entries()) {
      for (const [dependency, specifier] of Object.entries(manifest.dependencies ?? {})) {
        if (!specifier.startsWith('workspace:')) continue;
        expect(positions.has(dependency), `${manifest.name} needs published ${dependency}`).toBe(
          true,
        );
        expect(positions.get(dependency), `${manifest.name} depends on ${dependency}`).toBeLessThan(
          index,
        );
      }
    }
  });
});

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
it('rebuilds SDK output after a release-version change and rejects mismatched metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fas-sdk-release-'));
  try {
    await mkdir(join(root, 'packages/sdk'), { recursive: true });
    for (const path of [
      'packages/sdk/src',
      'packages/sdk/tsconfig.json',
      'packages/sdk/package.json',
      'tsconfig.base.json',
    ])
      await cp(path, join(root, path), { recursive: true });
    await symlink(resolve('node_modules'), join(root, 'node_modules'), 'junction');
    await symlink(
      resolve('packages/sdk/node_modules'),
      join(root, 'packages/sdk/node_modules'),
      'junction',
    );
    const pkg = JSON.parse(await readFile(join(root, 'packages/sdk/package.json'), 'utf8'));
    pkg.version = '123.4.5';
    await writeFile(join(root, 'packages/sdk/package.json'), JSON.stringify(pkg));
    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    await exec(shell, [resolve('scripts/prepare-sdk-release.sh'), '123.4.5'], { cwd: root });
    expect(await readFile(join(root, 'packages/sdk/dist/logger.js'), 'utf8')).toContain(
      "SDK_VERSION = '123.4.5'",
    );
    await expect(
      exec(shell, [resolve('scripts/prepare-sdk-release.sh'), '123.4.6'], { cwd: root }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBuildcheck } from './buildcheck.js';

const projects: string[] = [];
afterEach(async () => {
  for (const dir of projects.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir(), 'fas-buildcheck-')))
      throw new Error('Unsafe fixture cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});

async function project(text = 'My tasks', root = 'taskflow-react'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fas-buildcheck-'));
  projects.push(dir);
  await mkdir(join(dir, root, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{}');
  await symlink(
    resolve(import.meta.dirname, '../../../..', 'node_modules'),
    join(dir, 'node_modules'),
    'junction',
  );
  await writeFile(join(dir, root, 'package.json'), '{}');
  await writeFile(
    join(dir, root, 'index.html'),
    '<script type="module" src="./src/main.js"></script>',
  );
  await writeFile(
    join(dir, root, 'src/main.js'),
    `document.querySelector('#app').innerHTML = '<h1>${text}</h1>';`,
  );
  // Build fixture copies the chosen root's entry module into a fresh release directory.
  await writeFile(
    join(dir, root, 'build.mjs'),
    `import {mkdir,writeFile,copyFile} from 'node:fs/promises';
    await mkdir('../release');
    await copyFile('src/main.js', '../release/feature.js');
    await writeFile('../release/index.html', '<div id="app"></div><script src="./feature.js"></script>');`,
  );
  await writeFile(
    join(dir, 'fas.json'),
    JSON.stringify({
      appId: 'taskflow',
      deploy: {
        root,
        command: 'node build.mjs',
        output: 'release',
        smoke: { selector: 'h1', text: 'My tasks' },
      },
    }),
  );
  return dir;
}

describe('built release artifact smoke', () => {
  it('builds the declared alternate root and renders its product feature in Chromium', async () => {
    const dir = await project();
    expect(await runBuildcheck(dir, 'taskflow')).toBe('release');
    expect(await readFile(join(dir, 'release/feature.js'), 'utf8')).toContain('My tasks');
  }, 30000);
  it('blocks a wrong/starter artifact even when HTML and JS exist', async () => {
    const dir = await project('Welcome to the starter');
    await expect(runBuildcheck(dir, 'taskflow')).rejects.toThrow('did not render');
  }, 30000);
  it('refuses stale output before executing the build', async () => {
    const dir = await project();
    await mkdir(join(dir, 'release'));
    await expect(runBuildcheck(dir)).rejects.toThrow('already exists');
  });
  it('rejects a wrong upload identity before building', async () => {
    await expect(runBuildcheck(await project(), 'another-app')).rejects.toThrow('does not match');
  });
  it('does not accept an old artifact after a no-op build', async () => {
    const dir = await project();
    await writeFile(join(dir, 'taskflow-react/build.mjs'), '');
    await expect(runBuildcheck(dir)).rejects.toThrow();
  });
});

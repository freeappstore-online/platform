import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { readBuildTarget, validateBuildTarget } from './build-target.js';

function fixture(root = 'web', output = `${root}/dist`) {
  return new Map([
    ['fas.json', JSON.stringify({ appId: 'taskflow', applicationRoot: root, outputPath: output })],
    [
      'package.json',
      JSON.stringify({ name: 'taskflow', scripts: { build: `pnpm --dir ${root} build` } }),
    ],
    [`${root}/index.html`, '<script type="module" src="/src/main.tsx"></script>'],
    [`${root}/src/main.tsx`, "import App from './App'; initApp({appId: 'taskflow'});"],
    [`${root}/src/App.tsx`, 'export default function App() { return <button>Add task</button> }'],
    [`${output}/index.html`, '<script type="module" src="/assets/app.js"></script>'],
    [`${output}/assets/app.js`, 'document.body.innerHTML = "<button>Add task</button>";'],
  ]);
}

describe('build/deploy target', () => {
  it('supports an application at the repository root', async () => {
    const files = fixture();
    for (const [path, content] of [...files]) {
      if (path.startsWith('web/')) {
        files.delete(path);
        files.set(path.slice(4), content);
      }
    }
    files.set('fas.json', JSON.stringify({ appId: 'taskflow', applicationRoot: '.' }));
    files.set('package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
    expect((await validateBuildTarget(mapFileSource(files), { artifact: true })).status).toBe(
      'pass',
    );
    expect((await readBuildTarget(mapFileSource(files))).outputPath).toBe('dist');
  });
  it('traces the default source entry and produced artifact', async () => {
    expect((await validateBuildTarget(mapFileSource(fixture()), { artifact: true })).status).toBe(
      'pass',
    );
  });
  it('supports a custom app root and output directory', async () => {
    expect(
      (
        await validateBuildTarget(mapFileSource(fixture('apps/tasks', 'release/tasks')), {
          artifact: true,
        })
      ).status,
    ).toBe('pass');
  });
  it('accepts relative artifact script URLs and rejects a missing imported chunk', async () => {
    const files = fixture();
    files.set('web/dist/index.html', '<script src="assets/app.js?v=1"></script>');
    expect((await validateBuildTarget(mapFileSource(files), { artifact: true })).status).toBe(
      'pass',
    );
    files.set('web/dist/assets/app.js', 'import "./missing.js";');
    expect((await validateBuildTarget(mapFileSource(files), { artifact: true })).status).toBe(
      'fail',
    );
  });
  it('detects an existing deploy workflow uploading the wrong directory', async () => {
    const files = fixture('taskflow-react');
    files.set(
      '.github/workflows/deploy.yml',
      'run: aws s3 sync ./web/dist s3://fas-apps/apps/taskflow/',
    );
    expect((await validateBuildTarget(mapFileSource(files))).detail).toContain('uploads web/dist');
  });
  it('ignores upload examples in workflow comments', async () => {
    const files = fixture();
    files.set(
      '.github/workflows/deploy.yml',
      '# aws s3 sync from a different path\nrun: aws s3 sync ./web/dist s3://fas-apps/apps/taskflow/',
    );
    expect((await validateBuildTarget(mapFileSource(files), { artifact: true })).status).toBe(
      'pass',
    );
  });
  it('ignores commented identities and unrelated domain appId values', async () => {
    const files = fixture();
    files.set(
      'web/src/App.tsx',
      "// initApp({ appId: 'my-app' });\nconst example = { appId: 'some-other-app' }; export default example;",
    );
    expect((await validateBuildTarget(mapFileSource(files))).status).toBe('pass');
  });
  it('supports recursive workspace builds', async () => {
    const files = fixture('apps/tasks');
    files.set('package.json', JSON.stringify({ scripts: { build: 'pnpm -r build' } }));
    files.set('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n");
    expect((await validateBuildTarget(mapFileSource(files))).status).toBe('pass');
  });
  it('diagnoses TaskFlow: developed taskflow-react excluded while starter web deploys', async () => {
    const files = fixture();
    files.set('web/src/App.tsx', 'export default () => <h1>Welcome to FreeAppStore</h1>');
    files.set('taskflow-react/index.html', '<script src="/src/main.tsx"></script>');
    const result = await validateBuildTarget(mapFileSource(files));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('taskflow-react/index.html');
  });
  it('diagnoses DevEstimate SDK identity mismatch', async () => {
    const files = fixture();
    files.set('web/src/main.tsx', "initApp({appId: 'my-app'});");
    expect((await validateBuildTarget(mapFileSource(files))).detail).toContain(
      "SDK appId 'my-app'",
    );
  });
  it('preserves legitimate example/demo files and their placeholder identities', async () => {
    const files = fixture();
    files.set('examples/demo/index.html', 'Welcome to FreeAppStore');
    files.set('examples/demo/app.ts', "initApp({appId: 'my-app'})");
    expect((await validateBuildTarget(mapFileSource(files))).status).toBe('pass');
  });
  it('fails a selected package absent from the build', async () => {
    const files = fixture('taskflow-react');
    files.set('package.json', JSON.stringify({ scripts: { build: 'pnpm --filter ./web build' } }));
    expect((await validateBuildTarget(mapFileSource(files))).status).toBe('fail');
  });
  it('does not mistake a similarly named directory for the selected app', async () => {
    const files = fixture();
    files.set('package.json', JSON.stringify({ scripts: { build: 'pnpm --dir web-demo build' } }));
    expect((await validateBuildTarget(mapFileSource(files))).status).toBe('fail');
  });
  it('fails missing output and starter UI in release chunks', async () => {
    const files = fixture();
    files.delete('web/dist/assets/app.js');
    expect((await validateBuildTarget(mapFileSource(files), { artifact: true })).status).toBe(
      'fail',
    );
    files.set('web/dist/assets/app.js', 'document.body.innerHTML = "Welcome to FreeAppStore"');
    expect((await validateBuildTarget(mapFileSource(files), { artifact: true })).detail).toContain(
      'starter UI',
    );
  });
  it('checks the provisioned identity independently of the source identity', async () => {
    expect(
      (await validateBuildTarget(mapFileSource(fixture()), { expectedAppId: 'other' })).status,
    ).toBe('fail');
  });
  it.each(['../outside', '/absolute', 'C:/outside', 'web/../../outside'])(
    'rejects unsafe paths: %s',
    async (path) => {
      const files = fixture();
      files.set('fas.json', JSON.stringify({ appId: 'taskflow', applicationRoot: path }));
      expect((await validateBuildTarget(mapFileSource(files))).status).toBe('fail');
    },
  );
  it('reports invalid config and unresolved identity', async () => {
    const files = fixture();
    files.set('fas.json', '{');
    expect((await validateBuildTarget(mapFileSource(files))).status).toBe('fail');
    files.set('fas.json', '{"appId":"my-app"}');
    await expect(readBuildTarget(mapFileSource(files))).rejects.toThrow('identity');
  });
});

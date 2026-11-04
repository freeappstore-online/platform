import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkDeployTarget, parseDeployTarget } from './deploy-target.js';

function fixture(root = 'web', id = 'taskflow'): Map<string, string> {
  const prefix = root === '.' ? '' : `${root}/`;
  return new Map([
    [
      'fas.json',
      JSON.stringify({
        appId: 'taskflow',
        deploy: {
          root,
          command: 'pnpm build',
          output: `${prefix}release`,
          smoke: { selector: 'h1', text: 'My tasks' },
        },
      }),
    ],
    [`${prefix}package.json`, JSON.stringify({ scripts: { build: 'vite build' } })],
    [`${prefix}index.html`, '<script type="module" src="/src/main.tsx"></script>'],
    [`${prefix}src/main.tsx`, 'import App from "./App"; export default App;'],
    [
      `${prefix}src/App.tsx`,
      `import { initApp } from '@freeappstore/sdk'; initApp({appId: '${id}'}); export default () => <h1>My tasks</h1>;`,
    ],
  ]);
}

describe('deployment target fixtures (#344)', () => {
  it('rejects DevEstimate identity mismatch in the reachable app', async () => {
    const result = await checkDeployTarget(mapFileSource(fixture('web', 'my-app')));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('web/src/App.tsx');
    expect(result.detail).toContain('my-app');
  });
  it('detects TaskFlow deploying untouched web while taskflow-react is excluded', async () => {
    const files = fixture();
    files.set(
      'web/src/App.tsx',
      'export default () => <PageHeader description="Edit web/src/App.tsx to get started."/>;',
    );
    files.set('taskflow-react/package.json', '{"scripts":{"build":"vite build"}}');
    const result = await checkDeployTarget(mapFileSource(files));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('taskflow-react/package.json');
    expect(result.detail).toContain('outside this target');
  });
  it.each(['taskflow-react', 'apps/planner', '.'])(
    'accepts a declared custom/monorepo root %s',
    async (root) => {
      const files = fixture(root);
      files.set('examples/demo/src/App.tsx', 'initApp({appId:"my-app"})');
      files.set('examples/demo/package.json', '{}');
      const result = await checkDeployTarget(mapFileSource(files), 'taskflow');
      expect(result.status).toBe('pass');
      expect(result.detail).toContain('release');
    },
  );
  it('does not confuse comments, docs strings, or another initApp API with SDK identity', async () => {
    const files = fixture();
    files.set(
      'web/src/App.tsx',
      `// initApp({appId:'my-app'})
      const docs = "initApp({appId:'my-app'})";
      function initApp(options: unknown) {} initApp({appId:'demo'});
      export default () => <h1>My tasks</h1>;`,
    );
    expect((await checkDeployTarget(mapFileSource(files))).status).toBe('pass');
  });
  it('handles an aliased SDK import and rejects dynamic or spread identities', async () => {
    for (const args of ['{appId: getId()}', '{...config, appId: "taskflow"}', '{appId: "wrong"}']) {
      const files = fixture();
      files.set(
        'web/src/App.tsx',
        `import {initApp as start} from '@freeappstore/sdk'; start(${args});`,
      );
      expect((await checkDeployTarget(mapFileSource(files))).status).toBe('fail');
    }
  });
  it('rejects a declared identity different from the upload repository', async () => {
    expect((await checkDeployTarget(mapFileSource(fixture()), 'another-app')).status).toBe('fail');
  });
  it('reports malformed contracts and missing entrypoints', async () => {
    const files = fixture();
    files.set('fas.json', '{');
    expect((await checkDeployTarget(mapFileSource(files))).status).toBe('fail');
    files.set('fas.json', fixture().get('fas.json')!);
    files.delete('web/index.html');
    expect((await checkDeployTarget(mapFileSource(files))).detail).toContain('No HTML entry');
  });
  it.each(['../outside', '/tmp/release', 'C:/release', 'out\nput', 'out;echo'])(
    'refuses unsafe output %s',
    (output) => {
      const config = JSON.parse(fixture().get('fas.json')!);
      config.deploy.output = output;
      expect(() => parseDeployTarget(JSON.stringify(config))).toThrow();
    },
  );
  it('warns rather than blocks legacy projects merely lacking a contract', async () => {
    const files = fixture();
    files.delete('fas.json');
    expect((await checkDeployTarget(mapFileSource(files))).status).toBe('warn');
  });
});

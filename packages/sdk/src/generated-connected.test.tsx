// @vitest-environment happy-dom
import * as React from 'react';
import { act } from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getConfig } from '../../../workers/agent/src/config';
import {
  APP_ARCHETYPES,
  getTemplateFiles,
  substituteAppName,
} from '../../../workers/agent/src/template';
import * as hooks from './hooks.js';
import * as sdk from './index.js';
import * as ui from './ui.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let requests: Array<{ url: string; method: string }>;

// Compile and execute the generated modules themselves, with the real SDK,
// React, Shell and profile. Only the network is synthetic.
function compile(source: string, modules: Record<string, unknown>) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', code)((id: string) => {
    if (!(id in modules)) throw new Error(`Unexpected generated import: ${id}`);
    return modules[id];
  }, exports);
  return exports as { default: React.ComponentType; ConnectedDraft: React.ComponentType };
}

beforeEach(() => {
  history.replaceState(null, '', '/');
  localStorage.clear();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      return Response.json(url.includes('/kv/') ? 'private saved text' : []);
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it.each(APP_ARCHETYPES)(
  'generated connected %s shares profile auth and leaves public screens open',
  async (archetype) => {
    localStorage.setItem(
      'fas:session',
      JSON.stringify({
        token: 'synthetic-token',
        user: {
          id: 'synthetic-user',
          login: 'synthetic',
          avatarUrl: null,
          dateOfBirth: null,
        },
      }),
    );
    const files = substituteAppName(
      getTemplateFiles(getConfig('apps'), archetype, 'connected'),
      'test-app',
      'Test App',
    );
    const modules: Record<string, unknown> = {
      react: React,
      'react/jsx-runtime': jsx,
      '@freeappstore/sdk': sdk,
      '@freeappstore/sdk/hooks': hooks,
      '@freeappstore/sdk/ui': ui,
    };
    modules['./components/ConnectedDraft'] = compile(
      files['web/src/components/ConnectedDraft.tsx'],
      modules,
    );
    const App = compile(files['web/src/App.tsx'], modules).default;
    await act(async () => root.render(<App />));
    expect(container.querySelector('textarea')?.value).toBe('private saved text');
    const kvCount = () => requests.filter((r) => r.url.includes('/kv/')).length;
    const before = kvCount();
    await act(async () =>
      container.querySelector<HTMLAnchorElement>('a[aria-label="Profile"]')!.click(),
    );
    const signOut = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Sign out',
    );
    expect(signOut).toBeTruthy();
    await act(async () => signOut!.click());
    expect(localStorage.getItem('fas:session')).toBeNull();
    expect(container.textContent).toContain('GitHub');
    expect(container.textContent).toContain('Google');
    // Home is still accessible, but its private draft is now gated.
    await act(async () => {
      history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(container.textContent).toContain('Welcome to Test App');
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('private saved text');
    await act(async () => {
      history.pushState(null, '', '/about');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(container.textContent).toContain('Test App is a free app');
    expect(kvCount()).toBe(before);
    expect(requests.some((r) => r.url.includes('/auth/') && r.url.includes('/start'))).toBe(false);
  },
);

it('profile sign-out clears a mounted generated draft and blocks its retained save callback', async () => {
  localStorage.setItem(
    'fas:session',
    JSON.stringify({
      token: 'synthetic-token',
      user: {
        id: 'synthetic-user',
        login: 'synthetic',
        avatarUrl: null,
        dateOfBirth: null,
      },
    }),
  );
  const app = sdk.initApp({ appId: 'test-app' });
  const source = getTemplateFiles(getConfig('apps'), 'generic', 'connected')[
    'web/src/components/ConnectedDraft.tsx'
  ];
  const Feature = compile(source, {
    'react/jsx-runtime': jsx,
    '@freeappstore/sdk/hooks': hooks,
    '@freeappstore/sdk/ui': ui,
  }).ConnectedDraft as React.ComponentType<{ app: sdk.FreeAppStore }>;
  await act(async () =>
    root.render(
      <>
        <ui.ProfilePage app={app} />
        <Feature app={app} />
      </>,
    ),
  );
  const input = container.querySelector('textarea')!;
  expect(input.value).toBe('private saved text');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'unsaved secret');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Save',
  )!;
  expect(save.disabled).toBe(false);
  const signOut = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Sign out',
  )!;
  const before = requests.length;
  // Same event batch: the retained Save handler must check current auth, even
  // before React processes the sign-out notification and removes the editor.
  await act(async () => {
    signOut.click();
    save.click();
  });
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).not.toContain('unsaved secret');
  expect(requests.length).toBe(before);
  expect(app.auth.token).toBeNull();
});

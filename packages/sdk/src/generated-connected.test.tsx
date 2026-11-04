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
import * as pwaSdk from './pwa.js';
import { registerMediaBusyGuard } from './media.js';
import * as sdk from './index.js';
import * as ui from './ui.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let pwa: ReturnType<typeof pwaSdk.startPwa>;
let waiting: { postMessage: ReturnType<typeof vi.fn> };
let serviceWorker: ServiceWorkerContainer;
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
  waiting = { postMessage: vi.fn() };
  serviceWorker = Object.assign(new EventTarget(), {
    controller: {},
    register: vi
      .fn()
      .mockResolvedValue(Object.assign(new EventTarget(), { waiting, installing: null })),
  }) as unknown as ServiceWorkerContainer;
  Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
  const files = getTemplateFiles(getConfig('apps'), 'generic', 'connected');
  pwa = (
    compile(files['web/src/fas-capabilities/pwa.ts'], {
      '@freeappstore/sdk/pwa': pwaSdk,
    }) as unknown as { pwa: typeof pwa }
  ).pwa;
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
  pwa.dispose();
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
      '../fas-capabilities/pwa': { pwa },
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
    react: React,
    '../fas-capabilities/pwa': { pwa },
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
it.each(APP_ARCHETYPES)(
  'generated %s entry, draft and media share guarded updates (#370)',
  async (archetype) => {
    localStorage.setItem(
      'fas:session',
      JSON.stringify({ token: 'token', user: { id: 'user', login: 'user' } }),
    );
    const files = substituteAppName(
      getTemplateFiles(getConfig('apps'), archetype, 'connected'),
      'test-app',
      'Test App',
    );
    const canonical = { pwa };
    const alias = compile(files['web/src/pwa.ts'], {
      './fas-capabilities/pwa': canonical,
    }) as unknown as typeof canonical;
    expect(alias.pwa).toBe(pwa);
    const modules: Record<string, unknown> = {
      react: React,
      'react/jsx-runtime': jsx,
      '@freeappstore/sdk': sdk,
      '@freeappstore/sdk/hooks': hooks,
      '@freeappstore/sdk/ui': ui,
      '../fas-capabilities/pwa': canonical,
    };
    modules['./components/ConnectedDraft'] = compile(
      files['web/src/components/ConnectedDraft.tsx'],
      modules,
    );
    const appModule = compile(files['web/src/App.tsx'], modules);
    await act(async () => {
      compile(files['web/src/main.tsx'], {
        ...modules,
        './fas-capabilities/pwa': canonical,
        './App.tsx': appModule,
        './App': appModule,
        './index.css': {},
        'react-dom/client': { createRoot: () => root },
      });
    });
    await pwa.ready;
    expect(
      document.querySelectorAll('aside[aria-label="App installation and updates"]'),
    ).toHaveLength(1);
    expect(serviceWorker.register).toHaveBeenCalledOnce();
    const input = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'dirty notes',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('Unsaved changes');
    expect(alias.pwa.activate()).toBe(false);
    expect(waiting.postMessage).not.toHaveBeenCalled();
    // An update activated elsewhere must still be blocked from reloading dirty work.
    Object.assign(serviceWorker, { controller: {} });
    serviceWorker.dispatchEvent(new Event('controllerchange'));
    expect(alias.pwa.reload()).toBe(false);
    let recording = true;
    const removeMediaGuard = registerMediaBusyGuard(pwa, () => recording);
    await act(async () => {
      history.pushState(null, '', '/about');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(container.querySelector('textarea')).toBeNull();
    expect(alias.pwa.activate()).toBe(false);
    expect(alias.pwa.reload()).toBe(false);
    expect(waiting.postMessage).not.toHaveBeenCalled();
    recording = false;
    removeMediaGuard();
    expect(alias.pwa.activate()).toBe(true);
    expect(waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
  },
);

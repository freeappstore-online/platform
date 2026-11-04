// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useAuth } from './hooks.js';
import type { FreeAppStore } from './index.js';
import type { User } from './types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
function delayedApp(login: string) {
  let finish!: () => void;
  const init = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const user = { id: login, login, avatarUrl: null, dateOfBirth: null };
  return {
    finish,
    app: {
      auth: {
        user,
        init: () => init,
        onChange: (listener: (user: User) => void) => {
          listener(user);
          return () => {};
        },
      },
    } as unknown as FreeAppStore,
  };
}
function Probe({ app }: { app: FreeAppStore }) {
  const { user, loading } = useAuth(app);
  return <output>{loading ? 'loading' : user?.login}</output>;
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it('returns to loading when the app instance changes', async () => {
  const first = delayedApp('alice');
  const second = delayedApp('bob');
  await act(async () => {
    root.render(<Probe app={first.app} />);
    first.finish();
  });
  expect(container.textContent).toBe('alice');
  await act(async () => root.render(<Probe app={second.app} />));
  expect(container.textContent).toBe('loading');
  await act(async () => second.finish());
  expect(container.textContent).toBe('bob');
});
it('ignores completion from an app instance that is no longer rendered', async () => {
  const first = delayedApp('alice');
  const second = delayedApp('bob');
  await act(async () => root.render(<Probe app={first.app} />));
  await act(async () => root.render(<Probe app={second.app} />));
  await act(async () => first.finish());
  expect(container.textContent).toBe('loading');
  await act(async () => second.finish());
  expect(container.textContent).toBe('bob');
});

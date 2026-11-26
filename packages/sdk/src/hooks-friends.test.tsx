// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Friend } from './friends.js';
import { useFriends } from './hooks.js';
import type { FreeAppStore } from './index.js';
import type { User } from './types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

const friend = (login: string): Friend => ({
  userId: login,
  login,
  avatarUrl: null,
  status: 'accepted',
  since: 0,
});
const user = (login: string): User => ({ id: login, login, avatarUrl: null, dateOfBirth: null });

function fakeApp() {
  const listeners = new Set<(user: User | null) => void>();
  const pending: Array<{ login: string; resolve: () => void }> = [];
  const app = {
    auth: {
      user: null as User | null,
      init: () => Promise.resolve(),
      onChange: (listener: (user: User | null) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    friends: {
      list: () =>
        new Promise<Friend[]>((resolve) => {
          const login = app.auth.user?.login ?? '';
          pending.push({ login, resolve: () => resolve([friend(`${login}-friend`)]) });
        }),
      requests: () => Promise.resolve([]),
    },
  };
  const setUser = (next: User | null) => {
    app.auth.user = next;
    for (const listener of listeners) listener(next);
  };
  return { app: app as unknown as FreeAppStore, setUser, pending };
}

function Probe({ app }: { app: FreeAppStore }) {
  const { friends, loading } = useFriends(app);
  return <output>{loading ? 'loading' : friends.map((f) => f.login).join(',') || 'none'}</output>;
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

it('loads after sign-in and clears on sign-out', async () => {
  const { app, setUser, pending } = fakeApp();
  await act(async () => root.render(<Probe app={app} />));
  expect(container.textContent).toBe('none');
  expect(pending).toHaveLength(0);

  await act(async () => setUser(user('alice')));
  await act(async () => pending[0]!.resolve());
  expect(container.textContent).toBe('alice-friend');

  await act(async () => setUser(null));
  expect(container.textContent).toBe('none');
});

it('ignores a superseded response from the previous account', async () => {
  const { app, setUser, pending } = fakeApp();
  await act(async () => root.render(<Probe app={app} />));
  await act(async () => setUser(user('alice')));
  await act(async () => setUser(user('bob')));
  await act(async () => pending[1]!.resolve());
  expect(container.textContent).toBe('bob-friend');
  await act(async () => pending[0]!.resolve());
  expect(container.textContent).toBe('bob-friend');
});

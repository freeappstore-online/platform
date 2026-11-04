// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConnectedKvDraft } from './hooks.js';
import type { FreeAppStore } from './index.js';
import type { User } from './types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const user = (id: string): User => ({ id, login: id, avatarUrl: null, dateOfBirth: null });
let currentUser: User | null;
let authListeners: Array<(u: User | null) => void>;
let root: Root;
let container: HTMLDivElement;
let resolveLoad: ((v: string | null) => void) | undefined;
let rejectLoad: ((e: Error) => void) | undefined;
let rejectSave: ((e: Error) => void) | undefined;
let app: FreeAppStore;
function setup() {
  currentUser = user('alice');
  authListeners = [];
  const auth = {
    get user() {
      return currentUser;
    },
    init: vi.fn().mockResolvedValue(undefined),
    onChange(listener: (u: User | null) => void) {
      authListeners.push(listener);
      listener(currentUser);
      return () => {
        authListeners = authListeners.filter((l) => l !== listener);
      };
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
    deleteAccount: vi.fn(),
  };
  app = {
    auth,
    kv: {
      get: vi.fn(
        () =>
          new Promise<string | null>((resolve, reject) => {
            resolveLoad = resolve;
            rejectLoad = reject;
          }),
      ),
      set: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectSave = reject;
          }),
      ),
    },
  } as unknown as FreeAppStore;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
}
function Probe({
  draftKey = 'draft',
  sourceApp = app,
}: {
  draftKey?: string;
  sourceApp?: FreeAppStore;
}) {
  const draft = useConnectedKvDraft(sourceApp, draftKey, '');
  return (
    <div>
      <textarea
        aria-label="draft"
        value={draft.draft}
        onChange={(e) => draft.setDraft(e.currentTarget.value)}
      />
      <output>
        {draft.loading
          ? 'loading'
          : (draft.error ?? (draft.saving ? 'saving' : draft.dirty ? 'dirty' : 'ready'))}
      </output>
      <button onClick={() => void draft.save()}>save</button>
      <button onClick={draft.retry}>retry</button>
    </div>
  );
}
beforeEach(() => setup());
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('keeps typing when a delayed initial read completes', async () => {
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  const input = container.querySelector('textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'typed while loading');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    resolveLoad?.('old server value');
  });
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
    'typed while loading',
  );
  expect(container.querySelector('output')?.textContent).toBe('dirty');
});

it('preserves dirty text when retrying a failed read and reports write failures', async () => {
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  const input = container.querySelector('textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'keep my edit');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    rejectLoad?.(new Error('read unavailable'));
  });
  expect(container.querySelector('output')?.textContent).toBe('read unavailable');
  await act(async () => {
    container.querySelectorAll('button')[1]!.click();
    await Promise.resolve();
  });
  await act(async () => {
    resolveLoad?.('server value');
  });
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('keep my edit');
  expect(container.querySelector('output')?.textContent).toBe('dirty');
  await act(async () => {
    container.querySelectorAll('button')[0]!.click();
    await Promise.resolve();
  });
  await act(async () => {
    rejectSave?.(new Error('write unavailable'));
  });
  expect(container.querySelector('output')?.textContent).toBe('write unavailable');
});

it('keeps drafts across same-account profile refreshes and new object defaults', async () => {
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  await act(async () => {
    resolveLoad?.('initial value');
  });
  const input = container.querySelector('textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'profile-safe edit');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  currentUser = { ...user('alice'), avatarUrl: 'https://example.test/avatar.png' };
  await act(async () => {
    authListeners.forEach((listener) => {
      listener(currentUser);
    });
    await Promise.resolve();
  });
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
    'profile-safe edit',
  );
  expect(container.querySelector('output')?.textContent).toBe('dirty');
  expect(app.kv.get).toHaveBeenCalledTimes(1);

  function ObjectDefault() {
    const draft = useConnectedKvDraft(app, 'object-default', { text: '' });
    return <output>{draft.draft.text}</output>;
  }
  await act(async () => {
    root.render(<ObjectDefault />);
    await Promise.resolve();
  });
  await act(async () => {
    resolveLoad?.(null);
    await Promise.resolve();
  });
  expect(app.kv.get).toHaveBeenCalledTimes(2);
});

it('does not expose a prior key scope draft after the selected record changes', async () => {
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  const input = container.querySelector('textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'draft for first key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    root.render(<Probe draftKey="another-draft" />);
    await Promise.resolve();
  });
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  expect(container.querySelector('output')?.textContent).toBe('loading');
});

it('isolates the previous account read after account switch and sign-out', async () => {
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  const staleLoad = resolveLoad;
  currentUser = user('bob');
  await act(async () => {
    authListeners.forEach((listener) => {
      listener(currentUser);
    });
    await Promise.resolve();
  });
  staleLoad?.('alice secret');
  await act(async () => {
    await Promise.resolve();
  });
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  currentUser = null;
  await act(async () => {
    authListeners.forEach((listener) => {
      listener(null);
    });
    await Promise.resolve();
  });
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  expect(app.kv.get).toHaveBeenCalledTimes(2);
});

it('isolates a draft when the app instance changes even for the same account id', async () => {
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  const input = container.querySelector('textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'first app only');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const otherApp = {
    ...app,
    kv: { get: vi.fn(() => new Promise<string | null>(() => {})), set: vi.fn() },
  } as unknown as FreeAppStore;
  await act(async () => {
    root.render(<Probe sourceApp={otherApp} />);
    await Promise.resolve();
  });
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  expect(container.querySelector('output')?.textContent).toBe('loading');
});

it('settles saving when retry cancels a pending write and preserves the dirty draft', async () => {
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  await act(async () => {
    resolveLoad?.('initial');
  });
  const input = container.querySelector('textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'unsaved during save');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container.querySelectorAll('button')[0]!.click();
    await Promise.resolve();
  });
  expect(container.querySelector('output')?.textContent).toBe('saving');
  await act(async () => {
    container.querySelectorAll('button')[1]!.click();
    await Promise.resolve();
  });
  await act(async () => {
    rejectSave?.(new Error('write cancelled'));
    await Promise.resolve();
  });
  await act(async () => {
    resolveLoad?.('server value');
  });
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
    'unsaved during save',
  );
  expect(container.querySelector('output')?.textContent).toBe('dirty');
});

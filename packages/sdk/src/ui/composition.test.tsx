// @vitest-environment happy-dom
// Composable frame, account, and routing primitives (#347).

import { act, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FreeAppStore } from '../index.js';
import { AccountSettingsFixture } from './fixtures/fixture-account-settings.js';
import { BottomNavFixture } from './fixtures/fixture-bottom-nav.js';
import { CanvasReaderFixture } from './fixtures/fixture-canvas-reader.js';
import { DefaultFrameFixture } from './fixtures/fixture-default-frame.js';
import { SidebarNavFixture } from './fixtures/fixture-sidebar-nav.js';
import { Shell } from './layout.js';
import { AccountSection, ProfilePage } from './profile.js';
import { ToastProvider, useToast } from './shell-resilience.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeApp(signedIn = false) {
  const app = {
    appId: 'demo',
    auth: {
      user: signedIn ? { id: 'gh:1', login: 'alice', avatarUrl: null, dateOfBirth: null } : null,
      init: async () => {},
      onChange: () => () => {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      deleteAccount: vi.fn(),
    },
    log: { _renderError: vi.fn() },
    friends: { requests: async () => [] },
    keys: { manage: vi.fn() },
  } as unknown as FreeAppStore;
  return app;
}

let container: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

const landmarks = (tag: string) => container.querySelectorAll(tag);

beforeEach(() => {
  history.replaceState(null, '', '/notes?q=1#top');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('header control slot (#347)', () => {
  it('places headerActions in the only header and keeps the profile link', async () => {
    const app = fakeApp(true);
    await mount(
      <Shell app={app} appName="Notes" headerActions={<button type="button">New</button>}>
        <p>Hi</p>
      </Shell>,
    );
    expect(landmarks('header')).toHaveLength(1);
    expect(landmarks('main')).toHaveLength(1);
    const header = container.querySelector('header');
    expect(header?.querySelector('[data-fas-header-actions] button')?.textContent).toBe('New');
    expect(header?.querySelector('a[aria-label="Profile"]')).not.toBeNull();
    expect(header?.textContent).not.toContain('Sign in with');
    await act(async () =>
      header?.querySelector<HTMLAnchorElement>('a[aria-label="Profile"]')?.click(),
    );
    expect(app.auth.signIn).not.toHaveBeenCalled();
  });
});

describe('frame-independent toasts (#347)', () => {
  it('shows a toast from ToastProvider without Shell', async () => {
    function Saver() {
      const toast = useToast();
      const [label, setLabel] = useState('Save');
      return (
        <button
          type="button"
          onClick={() => {
            toast.show('Saved', { variant: 'success' });
            setLabel('Saved');
          }}
        >
          {label}
        </button>
      );
    }
    await mount(
      <ToastProvider>
        <Saver />
      </ToastProvider>,
    );
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('Saved');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('still refuses useToast when no provider is mounted', async () => {
    function Saver() {
      useToast();
      return null;
    }
    await expect(mount(<Saver />)).rejects.toThrow(
      'useToast must be used inside <Shell> or <ToastProvider>',
    );
  });
});

describe('embeddable account section (#347)', () => {
  it('offers GitHub and Google when signed out and does not sign in from the avatar', async () => {
    const app = fakeApp(false);
    const onNavigate = vi.fn();
    await mount(
      <AccountSection app={app} onNavigate={onNavigate}>
        <p>Notebook name</p>
      </AccountSection>,
    );
    expect(container.textContent).toContain('Sign in with GitHub');
    expect(container.textContent).toContain('Sign in with Google');
    expect(container.textContent).toContain('Notebook name');
    const profile = container.querySelector<HTMLAnchorElement>('a[aria-label="Profile"]');
    expect(profile?.getAttribute('href')).toContain('/profile?returnTo=');
    expect(profile?.className).toContain('min-h-11');
    await act(async () => profile?.click());
    expect(app.auth.signIn).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith(expect.stringContaining('/profile?returnTo='));
    expect(onNavigate.mock.calls[0]?.[0]).toContain(encodeURIComponent('/notes?q=1#top'));
  });

  it('links the signed-in avatar and name to the profile', async () => {
    const app = fakeApp(true);
    await mount(<AccountSection app={app} profileHref="/account" />);
    expect(container.textContent).toContain('alice');
    expect(container.textContent).not.toContain('Sign in with');
    const profile = container.querySelector<HTMLAnchorElement>('a[aria-label="Profile"]');
    expect(profile?.getAttribute('href')).toBe('/account');
    await act(async () => profile?.click());
    expect(app.auth.signIn).not.toHaveBeenCalled();
  });

  it('renders ProfilePage children after the built-in sections', async () => {
    await mount(
      <ProfilePage app={fakeApp(true)}>
        <p>Custom setting</p>
      </ProfilePage>,
    );
    expect(container.textContent).toContain('Custom setting');
    expect(container.textContent).toContain('Delete account');
    const body = container.textContent ?? '';
    expect(body.indexOf('Delete account')).toBeLessThan(body.indexOf('Custom setting'));
  });
});

describe('frame fixtures (#347)', () => {
  it('renders the default frame with one header, one main, and the header action', async () => {
    await mount(<DefaultFrameFixture app={fakeApp(true)} />);
    expect(landmarks('header')).toHaveLength(1);
    expect(landmarks('main')).toHaveLength(1);
    expect(container.querySelector('header [data-fas-header-actions]')?.textContent).toContain(
      'New',
    );
    expect(container.querySelector('nav[aria-label="Main"]')).not.toBeNull();
  });

  it('renders a sidebar frame with one of each landmark', async () => {
    await mount(<SidebarNavFixture app={fakeApp(false)} />);
    expect(landmarks('header')).toHaveLength(1);
    expect(landmarks('main')).toHaveLength(1);
    expect(landmarks('nav')).toHaveLength(1);
    expect(container.querySelector('nav')?.textContent).toContain('Tags');
    expect(container.textContent).toContain('Sign in with GitHub');
  });

  it('renders bottom navigation without a second header', async () => {
    await mount(<BottomNavFixture app={fakeApp(true)} />);
    expect(landmarks('header')).toHaveLength(1);
    expect(landmarks('main')).toHaveLength(1);
    expect(landmarks('nav')).toHaveLength(1);
    expect(container.querySelector('nav')?.textContent).toContain('Notes');
    expect(container.textContent).toContain('alice');
  });

  it('renders a focused canvas without a navigation landmark', async () => {
    await mount(<CanvasReaderFixture app={fakeApp(false)} />);
    expect(landmarks('header')).toHaveLength(1);
    expect(landmarks('main')).toHaveLength(1);
    expect(landmarks('nav')).toHaveLength(0);
    const canvas = container.querySelector('canvas');
    expect(canvas?.getAttribute('aria-label')).toBe('Drawing canvas');
    expect(canvas?.className).toContain('touch-none');
  });

  it('embeds account settings with an app-owned field', async () => {
    const app = fakeApp(false);
    await mount(<AccountSettingsFixture app={app} />);
    expect(landmarks('header')).toHaveLength(1);
    expect(landmarks('main')).toHaveLength(1);
    expect(landmarks('nav')).toHaveLength(0);
    expect(container.querySelector('input[aria-label="Notebook name"]')).not.toBeNull();
    expect(container.textContent).toContain('Sign in with Google');
    await act(async () =>
      container.querySelector<HTMLAnchorElement>('a[aria-label="Profile"]')?.click(),
    );
    expect(app.auth.signIn).not.toHaveBeenCalled();
  });
});

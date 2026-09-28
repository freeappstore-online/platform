// @vitest-environment happy-dom
// Shell's resilience and feedback layer (#89): error boundary, Suspense,
// toasts, offline banner, per-route title, PageHeader, skip link, and scroll +
// focus on client-side route changes.

import { act, lazy, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FreeAppStore } from '../index.js';
import { Shell } from './layout.js';
import type { NavItem } from './navbar.js';
import { PageHeader, useDocumentTitle } from './page.js';
import { useToast } from './shell-resilience.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeApp(signedIn = true) {
  const renderError = vi.fn();
  const app = {
    appId: 'demo',
    auth: {
      user: signedIn ? { id: 'gh:1', login: 'alice', avatarUrl: null, dateOfBirth: null } : null,
      init: async () => {},
      onChange: () => () => {},
    },
    log: { _renderError: renderError },
  } as unknown as FreeAppStore;
  return { app, renderError };
}

let container: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

/** Let a requestAnimationFrame callback scheduled by the last commit run. */
const nextFrame = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

const $ = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector(selector) as T | null;
const byText = (tag: string, text: string) =>
  [...container.querySelectorAll<HTMLElement>(tag)].find((e) => e.textContent === text);

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

beforeEach(() => {
  history.replaceState(null, '', '/');
  document.title = '';
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

// ── 1. Error boundary ───────────────────────────────────────────

describe('error boundary', () => {
  let explode = true;
  function Fragile() {
    if (explode) throw new Error('boom');
    return <p>recovered</p>;
  }

  beforeEach(() => {
    explode = true;
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports caught errors
  });

  it('a render error shows the shell fallback inside the shell, not a white screen, and is logged via app.log', async () => {
    const { app, renderError } = fakeApp();
    await mount(
      <Shell app={app} appName="Notes">
        <Fragile />
      </Shell>,
    );
    expect($('header')).not.toBeNull();
    const alert = $('main [role="alert"]');
    expect(alert?.textContent).toContain('Something went wrong');
    expect(renderError).toHaveBeenCalledTimes(1);
    expect(renderError).toHaveBeenCalledWith(
      'boom',
      expect.objectContaining({ path: '/', componentStack: expect.any(String) }),
    );
  });

  it('"Try again" renders the screen again', async () => {
    const { app } = fakeApp();
    await mount(
      <Shell app={app}>
        <Fragile />
      </Shell>,
    );
    explode = false;
    await act(async () => byText('button', 'Try again')?.click());
    expect($('main')?.textContent).toBe('recovered');
  });

  it('renderError replaces the fallback and gets the error and a reset', async () => {
    const { app } = fakeApp();
    await mount(
      <Shell
        app={app}
        renderError={({ error, reset }) => (
          <button type="button" onClick={reset}>
            custom: {error.message}
          </button>
        )}
      >
        <Fragile />
      </Shell>,
    );
    expect(byText('button', 'custom: boom')).toBeDefined();
    explode = false;
    await act(async () => byText('button', 'custom: boom')?.click());
    expect($('main')?.textContent).toBe('recovered');
  });

  it('navigating to another route clears the error', async () => {
    const { app } = fakeApp();
    const nav: NavItem[] = [
      { label: 'Home', href: '/' },
      { label: 'Notes', href: '/notes' },
    ];
    await mount(
      <Shell app={app} nav={nav} onNavigate={(href) => history.pushState(null, '', href)}>
        <Fragile />
      </Shell>,
    );
    expect($('[role="alert"]')).not.toBeNull();
    explode = false;
    await act(async () => byText('a', 'Notes')?.click());
    expect($('[role="alert"]')).toBeNull();
    expect($('main')?.textContent).toBe('recovered');
  });
});

// ── 2. Suspense ─────────────────────────────────────────────────

describe('Suspense', () => {
  const pending = () => lazy(() => new Promise<{ default: () => ReactNode }>(() => {}));

  it('a lazy-loaded screen shows the shell loading fallback inside main', async () => {
    const Screen = pending();
    const { app } = fakeApp();
    await mount(
      <Shell app={app}>
        <Screen />
      </Shell>,
    );
    expect($('header')).not.toBeNull();
    expect($('main .fas-shell-loading')).not.toBeNull();
  });

  it('renderLoading replaces the default fallback', async () => {
    const Screen = pending();
    const { app } = fakeApp();
    await mount(
      <Shell app={app} renderLoading={() => <p>loading notes…</p>}>
        <Screen />
      </Shell>,
    );
    expect($('main')?.textContent).toBe('loading notes…');
  });
});

// ── 3. Toasts ───────────────────────────────────────────────────

describe('toasts', () => {
  function Saver({ duration }: { duration?: number }) {
    const toast = useToast();
    return (
      <button
        type="button"
        onClick={() =>
          toast.show('Saved', {
            variant: 'success',
            ...(duration !== undefined ? { duration } : {}),
          })
        }
      >
        save
      </button>
    );
  }

  it('any screen raises a toast into the shell’s single polite live region', async () => {
    const { app } = fakeApp();
    await mount(
      <Shell app={app}>
        <Saver duration={0} />
      </Shell>,
    );
    const regions = container.querySelectorAll('.fas-toast-region');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('role')).toBe('status');
    expect(regions[0]?.getAttribute('aria-live')).toBe('polite');
    expect(regions[0]?.textContent).toBe(''); // present before the first message

    await act(async () => byText('button', 'save')?.click());
    const toast = regions[0]?.querySelector('.fas-toast');
    expect(toast?.textContent).toContain('Saved');
    expect(toast?.getAttribute('data-variant')).toBe('success');
    expect(toast?.querySelector('[role]')).toBeNull(); // items carry no live role of their own

    await act(async () =>
      container.querySelector<HTMLButtonElement>('.fas-toast [aria-label="Dismiss"]')?.click(),
    );
    expect(regions[0]?.textContent).toBe('');
  });

  it('dismisses itself after its duration', async () => {
    vi.useFakeTimers();
    try {
      const { app } = fakeApp();
      await mount(
        <Shell app={app}>
          <Saver />
        </Shell>,
      );
      await act(async () => byText('button', 'save')?.click());
      expect($('.fas-toast')).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect($('.fas-toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('useToast outside Shell throws a clear error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(mount(<Saver />)).rejects.toThrow('useToast must be used inside <Shell>');
  });
});

// ── 4. Offline banner ───────────────────────────────────────────

describe('offline banner', () => {
  const banner = () => $('.fas-offline');

  it('toggles on offline/online events in a polite live region, and can be dismissed until the next drop', async () => {
    const { app } = fakeApp();
    await mount(
      <Shell app={app}>
        <p>content</p>
      </Shell>,
    );
    expect(banner()).toBeNull();

    await act(async () => setOnline(false));
    expect(banner()?.textContent).toContain("You're offline");
    const region = banner()?.parentElement;
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-live')).toBe('polite');

    await act(async () => setOnline(true));
    expect(banner()).toBeNull();

    await act(async () => setOnline(false));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss offline notice"]')?.click(),
    );
    expect(banner()).toBeNull();

    await act(async () => setOnline(true));
    await act(async () => setOnline(false));
    expect(banner()).not.toBeNull();
  });
});

// ── 5–6. Titles and PageHeader ──────────────────────────────────

describe('per-route title and PageHeader', () => {
  const NAV: NavItem[] = [
    { label: 'Home', href: '/', title: 'Home — Notes' },
    { label: 'Tags', href: '/tags', title: 'Tags — Notes' },
  ];

  it('a nav item’s title becomes the tab title on its route, and follows navigation', async () => {
    const { app } = fakeApp();
    await mount(
      <Shell app={app} nav={NAV} onNavigate={(href) => history.pushState(null, '', href)}>
        <p>content</p>
      </Shell>,
    );
    expect(document.title).toBe('Home — Notes');
    await act(async () => byText('a', 'Tags')?.click());
    expect(document.title).toBe('Tags — Notes');
  });

  it('a screen’s useDocumentTitle wins over the nav item title', async () => {
    function NoteScreen() {
      useDocumentTitle('Groceries — Notes');
      return <PageHeader title="Groceries" />;
    }
    const { app } = fakeApp();
    await mount(
      <Shell app={app} nav={NAV}>
        <NoteScreen />
      </Shell>,
    );
    expect(document.title).toBe('Groceries — Notes');
  });

  it('PageHeader renders the screen’s single h1, focusable for route changes', async () => {
    const { app } = fakeApp();
    await mount(
      <Shell app={app}>
        <PageHeader
          title="Notes"
          description="All your notes"
          actions={<button type="button">New</button>}
        />
      </Shell>,
    );
    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe('Notes');
    expect(h1s[0]?.getAttribute('tabindex')).toBe('-1');
    expect(container.textContent).toContain('All your notes');
  });
});

// ── 7. Skip link ────────────────────────────────────────────────

describe('skip link', () => {
  it('is the first focusable element, targets main#main, and moves focus there', async () => {
    const { app } = fakeApp();
    await mount(
      <Shell app={app} nav={[{ label: 'Home', href: '/' }]}>
        <p>content</p>
      </Shell>,
    );
    const first = container.querySelector<HTMLAnchorElement>('a, button, input, [tabindex="0"]');
    expect(first?.textContent).toBe('Skip to content');
    expect(first?.getAttribute('href')).toBe('#main');
    const main = $('main#main');
    expect(main).not.toBeNull();

    await act(async () => first?.click());
    expect(document.activeElement).toBe(main);
    expect(location.hash).toBe(''); // no history entry for routers to see
  });
});

// ── 8–9. Route changes: scroll and focus ────────────────────────

describe('client-side route changes', () => {
  const NAV: NavItem[] = [
    { label: 'Home', href: '/' },
    { label: 'Notes', href: '/notes' },
  ];

  function setScrollY(y: number) {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  }

  it('forward navigation scrolls to the top; back/forward restores where the route was left', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const { app } = fakeApp();
    await mount(
      <Shell app={app} nav={NAV} onNavigate={(href) => history.pushState(null, '', href)}>
        <p>content</p>
      </Shell>,
    );

    setScrollY(300);
    await act(async () => byText('a', 'Notes')?.click());
    await nextFrame();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);

    setScrollY(50);
    await act(async () => {
      history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await nextFrame();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 300);
  });

  it('after navigation, focus lands on the new screen’s PageHeader h1', async () => {
    const { app } = fakeApp();
    // A minimal router: the app's own route state picks the screen.
    function App() {
      const [path, setPath] = useState('/');
      return (
        <Shell
          app={app}
          nav={NAV}
          onNavigate={(href) => {
            history.pushState(null, '', href);
            setPath(href);
          }}
        >
          <PageHeader title={path === '/notes' ? 'Notes' : 'Home'} />
        </Shell>
      );
    }
    await mount(<App />);
    const link = byText('a', 'Notes');
    link?.focus();
    await act(async () => link?.click());
    await nextFrame();
    expect(document.activeElement?.tagName).toBe('H1');
    expect(document.activeElement?.textContent).toBe('Notes');
  });

  it('with no heading, focus lands on main', async () => {
    const { app } = fakeApp();
    await mount(
      <Shell app={app} nav={NAV} onNavigate={(href) => history.pushState(null, '', href)}>
        <p>content</p>
      </Shell>,
    );
    await act(async () => byText('a', 'Notes')?.click());
    await nextFrame();
    expect(document.activeElement).toBe($('main'));
  });

  it('with ordinary links (no onNavigate) the shell leaves scroll to the browser', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const { app } = fakeApp();
    await mount(
      <Shell app={app} nav={NAV}>
        <p>content</p>
      </Shell>,
    );
    expect(history.scrollRestoration).not.toBe('manual');
    await act(async () => {
      history.replaceState(null, '', '/notes');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await nextFrame();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

// ── Backward compatibility ──────────────────────────────────────

describe('backward compatibility', () => {
  it('the sign-in gate is unchanged: no skip link, banner or toast region before sign-in', async () => {
    const { app } = fakeApp(false);
    await mount(
      <Shell app={app} requireAuth>
        <p>content</p>
      </Shell>,
    );
    expect(container.textContent).toContain('Sign in to continue.');
    expect($('.fas-skip-link')).toBeNull();
    expect($('.fas-toast-region')).toBeNull();
    expect($('main')).toBeNull();
  });
});

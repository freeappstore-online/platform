// @vitest-environment happy-dom
// Shell's main navigation (#88): given `nav`, the default Shell renders a
// `<nav aria-label="Main">` in its topbar with the current route marked; with no
// `nav` it renders exactly as before.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FreeAppStore } from '../index.js';
import { Shell } from './layout.js';
import { activeHref, NAVBAR_CSS, NavBar, type NavItem } from './navbar.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Notes', href: '/notes' },
  { label: 'Settings', href: '/settings' },
];

const currentHrefs = (html: string) =>
  [...html.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);

describe('NavBar markup', () => {
  it('renders a <nav aria-label="Main"> landmark with one link per item', () => {
    const html = renderToStaticMarkup(<NavBar items={ITEMS} currentPath="/" />);
    expect(html).toMatch(/^<nav aria-label="Main"/);
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain('href="/notes"');
  });

  it('marks exactly the current item with aria-current="page", matching nested routes to their section', () => {
    const current = (path: string) =>
      currentHrefs(renderToStaticMarkup(<NavBar items={ITEMS} currentPath={path} />));
    expect(current('/')).toEqual(['/']);
    expect(current('/notes')).toEqual(['/notes']);
    expect(current('/notes/42')).toEqual(['/notes']);
    expect(current('/notesx')).toEqual([]);
    expect(current('/unknown')).toEqual([]);
  });

  it('has a labelled menu button that controls the list, collapsed by default', () => {
    const html = renderToStaticMarkup(<NavBar items={ITEMS} currentPath="/" />);
    const controls = /aria-expanded="false" aria-controls="([^"]+)" aria-label="Menu"/.exec(html);
    expect(controls).not.toBeNull();
    expect(html).toContain(`<ul id="${controls?.[1]}"`);
    expect(html).toContain('data-open="false"');
  });

  it('renders nothing when there are no items', () => {
    expect(renderToStaticMarkup(<NavBar items={[]} />)).toBe('');
  });

  it('ships 44px targets, visible focus and the small-screen collapse, on tokens only', () => {
    expect(NAVBAR_CSS).toContain('min-height:44px');
    expect(NAVBAR_CSS).toContain(':focus-visible');
    expect(NAVBAR_CSS).toContain('@media (max-width:639px)');
    expect(NAVBAR_CSS).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it('activeHref prefers the longest matching prefix and never matches "/" by prefix', () => {
    const nested = [
      { label: 'a', href: '/a' },
      { label: 'ab', href: '/a/b' },
    ];
    expect(activeHref(nested, '/a/b/c')).toBe('/a/b');
    expect(activeHref(ITEMS, '/settings/profile')).toBe('/settings');
    expect(activeHref(ITEMS, '/x')).toBeNull();
  });
});

// ── mounted in a DOM ─────────────────────────────────────────────

/** An SDK instance with a signed-in user. */
function fakeApp(): FreeAppStore {
  const user = { id: 'gh:1', login: 'alice', avatarUrl: null, dateOfBirth: null };
  return {
    appId: 'demo',
    auth: { user, init: async () => {}, onChange: () => () => {} },
  } as unknown as FreeAppStore;
}

let container: HTMLDivElement;
let root: Root;

async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

const navs = () => container.querySelectorAll('nav');
const link = (label: string) =>
  [...container.querySelectorAll('a')].find((a) => a.textContent === label) as HTMLAnchorElement;

beforeEach(() => {
  history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Shell navigation (#88)', () => {
  it('REGRESSION: the default Shell renders a <nav aria-label="Main"> in its topbar when nav items are supplied', async () => {
    await mount(
      <Shell app={fakeApp()} appName="Notes" nav={ITEMS}>
        <p>content</p>
      </Shell>,
    );
    const nav = container.querySelector('header nav[aria-label="Main"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelectorAll('a')).toHaveLength(3);
    expect(link('Home').getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('main')?.textContent).toBe('content');
  });

  it('without nav, the Shell is unchanged: no <nav> at all', async () => {
    await mount(
      <Shell app={fakeApp()} appName="Notes">
        <p>content</p>
      </Shell>,
    );
    expect(container.querySelector('header')).not.toBeNull();
    expect(navs()).toHaveLength(0);
  });

  it('an empty nav list is the same as no nav', async () => {
    await mount(
      <Shell app={fakeApp()} nav={[]}>
        <p>content</p>
      </Shell>,
    );
    expect(navs()).toHaveLength(0);
  });

  it('renderNav replaces the built-in NavBar, in the topbar, with the items, current path and a navigate function', async () => {
    const onNavigate = vi.fn();
    const renderNav = vi.fn(({ items, currentPath, onNavigate: go }) => (
      <nav aria-label="Custom">
        {items.map((i: NavItem) => (
          <button key={i.href} type="button" onClick={() => go(i.href)}>
            {i.label}
            {i.href === currentPath ? ' (here)' : ''}
          </button>
        ))}
      </nav>
    ));
    await mount(
      <Shell app={fakeApp()} nav={ITEMS} renderNav={renderNav} onNavigate={onNavigate}>
        <p>content</p>
      </Shell>,
    );
    expect(container.querySelector('nav[aria-label="Main"]')).toBeNull();
    expect(container.querySelector('header nav[aria-label="Custom"]')).not.toBeNull();
    expect(container.textContent).toContain('Home (here)');

    const notes = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Notes'),
    ) as HTMLButtonElement;
    await act(async () => notes.click());
    expect(onNavigate).toHaveBeenCalledWith('/notes');
    expect(container.textContent).toContain('Notes (here)');
  });

  it('with onNavigate, a plain click navigates client-side and moves aria-current', async () => {
    const onNavigate = vi.fn();
    await mount(
      <Shell app={fakeApp()} nav={ITEMS} onNavigate={onNavigate}>
        <p>content</p>
      </Shell>,
    );
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => link('Notes').dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith('/notes');
    expect(link('Notes').getAttribute('aria-current')).toBe('page');
    expect(link('Home').getAttribute('aria-current')).toBeNull();
  });

  it('keeps nav hidden behind the sign-in gate', async () => {
    const app = {
      appId: 'demo',
      auth: { user: null, init: async () => {}, onChange: () => () => {} },
    } as unknown as FreeAppStore;
    await mount(
      <Shell app={app} nav={ITEMS} requireAuth>
        <p>content</p>
      </Shell>,
    );
    expect(navs()).toHaveLength(0);
    expect(container.textContent).toContain('Sign in to continue.');
  });
});

describe('NavBar behaviour', () => {
  it('the menu button toggles aria-expanded; Escape closes it and returns focus to the button', async () => {
    await mount(<NavBar items={ITEMS} currentPath="/" />);
    const toggle = container.querySelector('button[aria-label="Menu"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('nav')?.getAttribute('data-open')).toBe('true');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('modified clicks are left to the browser', async () => {
    const onNavigate = vi.fn();
    await mount(<NavBar items={ITEMS} onNavigate={onNavigate} />);
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    await act(async () => link('Notes').dispatchEvent(click));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);
  });

  it('without onNavigate, items are ordinary links', async () => {
    await mount(<NavBar items={ITEMS} />);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link('Notes').addEventListener('click', (e) => e.preventDefault()); // keep happy-dom from navigating
    await act(async () => link('Notes').dispatchEvent(click));
    expect(link('Home').getAttribute('aria-current')).toBe('page');
  });

  it('follows back/forward (popstate) when no currentPath is given', async () => {
    await mount(<NavBar items={ITEMS} />);
    expect(link('Home').getAttribute('aria-current')).toBe('page');
    await act(async () => {
      history.pushState(null, '', '/settings/profile');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(link('Settings').getAttribute('aria-current')).toBe('page');
    expect(link('Home').getAttribute('aria-current')).toBeNull();
  });

  it('injects its stylesheet once', async () => {
    await mount(
      <>
        <NavBar items={ITEMS} currentPath="/" />
        <NavBar items={ITEMS} currentPath="/" />
      </>,
    );
    expect(document.querySelectorAll('#fas-nav-css')).toHaveLength(1);
  });
});

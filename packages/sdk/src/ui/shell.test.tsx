// Regression tests for Shell (#87): the landmarks and the auth gate every FAS
// app gets from wrapping itself in <Shell app={fas}>.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({
  useState: (init: unknown) => [
    typeof init === 'function' ? (init as () => unknown)() : init,
    vi.fn(),
  ],
  useEffect: vi.fn(),
  useCallback: (fn: unknown) => fn,
  useRef: () => ({ current: null }),
  useSyncExternalStore: (_sub: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useMemo: (fn: () => unknown) => fn(),
  useContext: vi.fn(),
  useInsertionEffect: vi.fn(),
  useLayoutEffect: vi.fn(),
  createContext: () => ({ Provider: 'Provider' }),
  Suspense: 'Suspense',
  Component: class {},
}));

// JSX becomes a plain { type, props } tree we can search.
vi.mock('react/jsx-runtime', () => ({
  jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  Fragment: Symbol('Fragment'),
}));

const auth = vi.hoisted(() => ({
  user: null as { id: string; login: string } | null,
  loading: false,
}));
vi.mock('../hooks.js', () => ({
  useAuth: () => ({ ...auth, signIn: vi.fn(), signOut: vi.fn(), deleteAccount: vi.fn() }),
  useTheme: () => ({ preference: 'system', setPreference: vi.fn() }),
}));

interface Node {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('type' in tree)) return [];
  const node = tree as Node;
  return [node, ...nodes(node.props.children)];
}

const text = (tree: unknown): string =>
  typeof tree === 'string'
    ? tree
    : nodes(tree)
        .map((n) =>
          [n.props.children]
            .flat()
            .filter((c) => typeof c === 'string')
            .join(''),
        )
        .join(' ');

const APP = {} as never;
const CHILD = { type: 'section', props: { 'data-testid': 'app-content' } };

async function renderShell(props: Record<string, unknown> = {}) {
  const { Shell } = await import('./layout.js');
  return nodes(Shell({ app: APP, appName: 'Notes', children: CHILD, ...props } as never));
}

const hasChild = (tree: Node[]) => tree.some((n) => n.props['data-testid'] === 'app-content');

describe('Shell', () => {
  beforeEach(() => {
    auth.user = null;
    auth.loading = false;
  });

  it('renders one header and one main landmark, with the app inside main', async () => {
    auth.user = { id: 'gh:1', login: 'alice' };
    const tree = await renderShell();
    expect(tree.filter((n) => n.type === 'header')).toHaveLength(1);
    const main = tree.filter((n) => n.type === 'main');
    expect(main).toHaveLength(1);
    expect(hasChild(nodes(main[0]))).toBe(true);
  });

  it('shows only the supplied app name in the topbar without a storefront link', async () => {
    auth.user = { id: 'gh:1', login: 'alice' };
    const tree = await renderShell();
    const header = nodes(tree.find((n) => n.type === 'header'));
    const hrefs = header.map((n) => n.props.href).filter(Boolean);
    expect(hrefs).not.toContain('https://freeappstore.online');
    expect(hrefs.join(' ')).not.toMatch(/proappstore/);
    expect(text(header)).toContain('Notes');
    expect(text(header)).not.toMatch(/\bFree\b/);
  });

  it('renders headerActions in the single topbar without a sign-in button', async () => {
    const action = {
      type: 'button',
      props: { children: 'New', 'data-testid': 'header-action' },
    };
    const tree = await renderShell({ headerActions: action });
    expect(tree.filter((n) => n.type === 'header')).toHaveLength(1);
    const header = nodes(tree.find((n) => n.type === 'header'));
    expect(header.some((n) => n.props['data-testid'] === 'header-action')).toBe(true);
    expect(header.some((n) => n.props['data-fas-header-actions'] !== undefined)).toBe(true);
    const { SignInButton } = await import('./core.js');
    expect(header.some((n) => n.type === SignInButton)).toBe(false);
    expect(header.some((n) => n.type === 'a' && n.props['aria-label'] === 'Profile')).toBe(true);
  });

  it('shows the profile link without secondary settings in the default topbar', async () => {
    auth.user = { id: 'gh:1', login: 'alice' };
    const { TextSizeToggle } = await import('./core.js');
    const header = nodes((await renderShell()).find((n) => n.type === 'header'));
    expect(header.some((n) => n.type === 'a' && n.props['aria-label'] === 'Profile')).toBe(true);
    expect(header.some((n) => n.type === TextSizeToggle)).toBe(false);
  });

  it('keeps appearance buttons in the topbar for an app-owned profile route unless headerAppearance is false (#603)', async () => {
    const { TextSizeToggle, ThemeToggle } = await import('./core.js');
    const appearance = async (props: Record<string, unknown>) => {
      const header = nodes(
        (await renderShell({ profileHref: '/account', ...props })).find((n) => n.type === 'header'),
      );
      return [TextSizeToggle, ThemeToggle].map((toggle) => header.some((n) => n.type === toggle));
    };
    expect(await appearance({})).toEqual([true, true]);
    expect(await appearance({ headerAppearance: false })).toEqual([false, false]);
  });

  it('without requireAuth, renders the app to signed-out users with a profile link and appearance settings in Profile', async () => {
    const { SignInButton, ThemeToggle } = await import('./core.js');
    const tree = await renderShell();
    expect(hasChild(tree)).toBe(true);
    const header = nodes(tree.find((n) => n.type === 'header'));
    expect(header.some((n) => n.type === SignInButton)).toBe(false);
    expect(header.some((n) => n.type === 'a' && n.props.href === '/profile')).toBe(true);
    expect(header.some((n) => n.type === ThemeToggle)).toBe(false);
  });

  describe('auth gate (requireAuth)', () => {
    it('signed out: shows a sign-in prompt, not the app', async () => {
      const { SignInButton } = await import('./core.js');
      const tree = await renderShell({ requireAuth: true });
      expect(hasChild(tree)).toBe(false);
      expect(tree.some((n) => n.type === 'main')).toBe(true);
      expect(tree.some((n) => n.type === SignInButton)).toBe(false);
      expect(tree.filter((n) => n.type === 'h1')).toHaveLength(1);
      expect(text(tree)).toContain('Sign in to continue.');
    });

    it('signed in: renders the app inside the shell', async () => {
      auth.user = { id: 'google:123', login: 'alice' };
      const tree = await renderShell({ requireAuth: true });
      expect(hasChild(tree)).toBe(true);
      expect(tree.some((n) => n.type === 'header')).toBe(true);
    });

    it('while auth loads: renders neither the app nor the sign-in prompt', async () => {
      auth.loading = true;
      const { SignInButton } = await import('./core.js');
      const tree = await renderShell({ requireAuth: true });
      expect(hasChild(tree)).toBe(false);
      expect(tree.some((n) => n.type === SignInButton)).toBe(false);
    });

    it('has no subscription or upgrade wall (FAS is free)', async () => {
      const tree = await renderShell({ requireAuth: true });
      expect(text(tree)).not.toMatch(/subscri|upgrade|pro\b/i);
    });
  });
});

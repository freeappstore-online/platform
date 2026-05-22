import { describe, expect, it, vi } from 'vitest';

// Mock React for node environment
vi.mock('react', () => {
  class MockComponent { render() { return null; } }
  return {
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, vi.fn()],
    useEffect: vi.fn(),
    useCallback: (fn: unknown) => fn,
    useRef: () => ({ current: null }),
    useSyncExternalStore: (_sub: unknown, getSnapshot: () => unknown) => getSnapshot(),
    Component: MockComponent,
  };
});

// Mock react/jsx-runtime
vi.mock('react/jsx-runtime', () => ({
  jsx: (type: string | Function, props: Record<string, unknown>) => ({ type, props }),
  jsxs: (type: string | Function, props: Record<string, unknown>) => ({ type, props }),
  Fragment: Symbol('Fragment'),
}));

describe('UI component exports', () => {
  it('exports all expected components', async () => {
    const mod = await import('./ui.js');
    expect(typeof mod.Avatar).toBe('function');
    expect(typeof mod.SignInButton).toBe('function');
    expect(typeof mod.ThemeToggle).toBe('function');
    expect(typeof mod.ProfileMenu).toBe('function');
    expect(typeof mod.ProfilePage).toBe('function');
    expect(typeof mod.FasShell).toBe('function');
    expect(typeof mod.Spinner).toBe('function');
    expect(typeof mod.Badge).toBe('function');
    expect(typeof mod.Card).toBe('function');
    expect(typeof mod.Tabs).toBe('function');
    expect(typeof mod.Modal).toBe('function');
    expect(typeof mod.ConfirmDialog).toBe('function');
    expect(typeof mod.EmptyState).toBe('function');
    expect(typeof mod.ProgressBar).toBe('function');
    expect(typeof mod.SearchInput).toBe('function');
    expect(typeof mod.ListRow).toBe('function');
    expect(typeof mod.ErrorBoundary).toBe('function');
  });

  it('Avatar renders with user', async () => {
    const mod = await import('./ui.js');
    const result = mod.Avatar({
      user: { id: '1', login: 'test', avatarUrl: 'https://example.com/avatar.png', dateOfBirth: null },
      size: 32,
    });
    expect(result).toBeDefined();
  });

  it('Avatar renders fallback without avatarUrl', async () => {
    const mod = await import('./ui.js');
    const result = mod.Avatar({
      user: { id: '1', login: 'test', avatarUrl: null, dateOfBirth: null },
      size: 32,
    });
    expect(result).toBeDefined();
  });

  it('Avatar renders fallback with null user', async () => {
    const mod = await import('./ui.js');
    const result = mod.Avatar({ user: null, size: 32 });
    expect(result).toBeDefined();
  });
});

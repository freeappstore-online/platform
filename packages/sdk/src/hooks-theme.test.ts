// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (init: unknown) => [init, vi.fn()],
  useEffect: vi.fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (init: unknown) => ({ current: init }),
}));

describe('useTheme with the system preference', () => {
  it('reports the new theme after the OS switches to dark', async () => {
    let dark = false;
    let onChange: (() => void) | undefined;
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return dark;
      },
      addEventListener: (_type: string, fn: () => void) => {
        onChange = fn;
      },
    }));
    const { useTheme } = await import('./hooks.js');
    expect(useTheme().theme).toBe('light');

    dark = true;
    onChange?.();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(useTheme().theme).toBe('dark');
  });
});

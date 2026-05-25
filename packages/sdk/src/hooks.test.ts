import { describe, expect, it, vi } from 'vitest';

// Mock React hooks since we're running in node environment
vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useState: (init: unknown) => [
    typeof init === 'function' ? (init as () => unknown)() : init,
    vi.fn(),
  ],
  useEffect: vi.fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (init: unknown) => ({ current: init }),
}));

describe('hooks exports', () => {
  it('exports useAuth function', async () => {
    const mod = await import('./hooks.js');
    expect(typeof mod.useAuth).toBe('function');
  });

  it('exports useTheme function', async () => {
    const mod = await import('./hooks.js');
    expect(typeof mod.useTheme).toBe('function');
  });

  it('useTheme returns expected shape', async () => {
    const mod = await import('./hooks.js');
    const result = mod.useTheme();
    expect(result).toHaveProperty('theme');
    expect(result).toHaveProperty('preference');
    expect(typeof result.setPreference).toBe('function');
    // In node env (no window), defaults to light/system
    expect(result.theme).toBe('light');
    expect(result.preference).toBe('system');
  });

  it('re-exports User type', async () => {
    // Type-only export — just verify module loads without error
    const mod = await import('./hooks.js');
    expect(mod).toBeDefined();
  });

  it('exports useFriends function', async () => {
    const mod = await import('./hooks.js');
    expect(typeof mod.useFriends).toBe('function');
  });

  it('exports useVoiceInput function', async () => {
    const mod = await import('./hooks.js');
    expect(typeof mod.useVoiceInput).toBe('function');
  });

  it('useVoiceInput returns expected shape', async () => {
    const mod = await import('./hooks.js');
    const result = mod.useVoiceInput();
    expect(result).toHaveProperty('isListening');
    expect(result).toHaveProperty('isSupported');
    expect(result).toHaveProperty('transcript');
    expect(typeof result.start).toBe('function');
    expect(typeof result.stop).toBe('function');
    expect(typeof result.toggle).toBe('function');
    expect(result.isSupported).toBe(false); // node env
  });
});

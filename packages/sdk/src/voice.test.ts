import { describe, expect, it, vi } from 'vitest';

// Mock React hooks since we're running in node environment
vi.mock('react', () => ({
  useState: (init: unknown) => [
    typeof init === 'function' ? (init as () => unknown)() : init,
    vi.fn(),
  ],
  useEffect: vi.fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (init: unknown) => ({ current: init }),
}));

describe('useVoiceInput', () => {
  it('exports useVoiceInput function', async () => {
    const mod = await import('./voice.js');
    expect(typeof mod.useVoiceInput).toBe('function');
  });

  it('returns expected shape', async () => {
    const mod = await import('./voice.js');
    const result = mod.useVoiceInput();
    expect(result).toHaveProperty('isListening');
    expect(result).toHaveProperty('isSupported');
    expect(result).toHaveProperty('transcript');
    expect(typeof result.start).toBe('function');
    expect(typeof result.stop).toBe('function');
    expect(typeof result.toggle).toBe('function');
  });

  it('isSupported is false in node environment', async () => {
    const mod = await import('./voice.js');
    const result = mod.useVoiceInput();
    expect(result.isSupported).toBe(false);
  });

  it('isListening defaults to false', async () => {
    const mod = await import('./voice.js');
    const result = mod.useVoiceInput();
    expect(result.isListening).toBe(false);
  });

  it('transcript defaults to empty string', async () => {
    const mod = await import('./voice.js');
    const result = mod.useVoiceInput();
    expect(result.transcript).toBe('');
  });

  it('start/stop/toggle are no-ops when unsupported', async () => {
    const mod = await import('./voice.js');
    const result = mod.useVoiceInput();
    // Should not throw
    result.start();
    result.stop();
    result.toggle();
  });
});

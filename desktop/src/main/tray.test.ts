import { describe, expect, it, vi } from 'vitest';
import { trayMenu, trayStatus } from './tray.js';

describe('tray menu', () => {
  it('shows the status, then Open, Pause or Resume, and Quit', () => {
    const actions = { open: vi.fn(), setPaused: vi.fn(), quit: vi.fn() };
    const on = trayMenu({ paused: false, openApps: 2, serverError: null }, actions);
    expect(on.map((item) => item.label ?? item.type)).toEqual([
      'FreeAppStore: On, 2 apps connected',
      'separator',
      'Open FreeAppStore',
      'Pause AI access',
      'separator',
      'Quit FreeAppStore',
    ]);
    on[3]!.click!(undefined as never, undefined, undefined as never);
    expect(actions.setPaused).toHaveBeenCalledWith(true);

    const paused = trayMenu({ paused: true, openApps: 1, serverError: null }, actions);
    expect(paused[0]!.label).toBe('FreeAppStore: AI access paused');
    expect(paused[3]!.label).toBe('Resume AI access');
    paused[3]!.click!(undefined as never, undefined, undefined as never);
    expect(actions.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('says when the server could not start', () => {
    expect(trayStatus({ paused: false, openApps: 0, serverError: 'Port in use' })).toBe(
      'FreeAppStore: AI access unavailable',
    );
    expect(trayStatus({ paused: false, openApps: 1, serverError: null })).toBe(
      'FreeAppStore: On, 1 app connected',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { trayMenu, trayStatus } from './tray.js';

describe('tray menu', () => {
  it('shows the status, then Open, Pause or Resume, and Quit', () => {
    const actions = {
      open: vi.fn(),
      setPaused: vi.fn(),
      setContributePaused: vi.fn(),
      update: vi.fn(),
      quit: vi.fn(),
    };
    const on = trayMenu(
      { paused: false, openApps: 2, serverError: null, contribute: null },
      actions,
    );
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

    const paused = trayMenu(
      { paused: true, openApps: 1, serverError: null, contribute: null },
      actions,
    );
    expect(paused[0]!.label).toBe('FreeAppStore: AI access paused');
    expect(paused[3]!.label).toBe('Resume AI access');
    paused[3]!.click!(undefined as never, undefined, undefined as never);
    expect(actions.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('says when the server could not start', () => {
    expect(
      trayStatus({ paused: false, openApps: 0, serverError: 'Port in use', contribute: null }),
    ).toBe('FreeAppStore: AI access unavailable');
    expect(trayStatus({ paused: false, openApps: 1, serverError: null, contribute: null })).toBe(
      'FreeAppStore: On, 1 app connected',
    );
  });

  it('adds Contribute’s status and Pause / Resume while connected (#826)', () => {
    const actions = {
      open: vi.fn(),
      setPaused: vi.fn(),
      setContributePaused: vi.fn(),
      update: vi.fn(),
      quit: vi.fn(),
    };
    const base = { paused: false, openApps: 0, serverError: null };
    const status = 'Contribute: books, sentence 3 of 40';
    const running = trayMenu({ ...base, contribute: { status, paused: false } }, actions);
    expect(running.map((item) => item.label ?? item.type)).toEqual([
      'FreeAppStore: On, 0 apps connected',
      'separator',
      'Open FreeAppStore',
      'Pause AI access',
      'separator',
      status,
      'Pause contributing',
      'separator',
      'Quit FreeAppStore',
    ]);
    running[6]!.click!(undefined as never, undefined, undefined as never);
    expect(actions.setContributePaused).toHaveBeenCalledWith(true);
    const paused = trayMenu({ ...base, contribute: { status, paused: true } }, actions);
    paused[6]!.click!(undefined as never, undefined, undefined as never);
    expect(actions.setContributePaused).toHaveBeenLastCalledWith(false);
  });

  it('shows the signed-in account, which opens the window (#829)', () => {
    const actions = {
      open: vi.fn(),
      setPaused: vi.fn(),
      setContributePaused: vi.fn(),
      update: vi.fn(),
      quit: vi.fn(),
    };
    const menu = trayMenu(
      {
        paused: false,
        openApps: 0,
        serverError: null,
        contribute: null,
        account: { name: 'serge-ivo', icon: null },
      },
      actions,
    );
    expect(menu.map((item) => item.label ?? item.type).slice(-4)).toEqual([
      'separator',
      'serge-ivo',
      'separator',
      'Quit FreeAppStore',
    ]);
    menu.at(-3)!.click!(undefined as never, undefined, undefined as never);
    expect(actions.open).toHaveBeenCalled();
  });

  it('shows an available update after the status (#839)', () => {
    const actions = {
      open: vi.fn(),
      setPaused: vi.fn(),
      setContributePaused: vi.fn(),
      update: vi.fn(),
      quit: vi.fn(),
    };
    const base = { paused: false, openApps: 0, serverError: null, contribute: null };
    const ready = trayMenu({ ...base, update: { version: '0.4.0', ready: true } }, actions);
    expect(ready[1]!.label).toBe('Update available: restart to update to 0.4.0');
    ready[1]!.click!(undefined as never, undefined, undefined as never);
    expect(actions.update).toHaveBeenCalled();
    const manual = trayMenu({ ...base, update: { version: '0.4.0', ready: false } }, actions);
    expect(manual[1]!.label).toBe('Update available: download version 0.4.0');
  });
});

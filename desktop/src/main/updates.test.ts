import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY, Updates } from './updates.js';

function fakeUpdater() {
  return Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(),
  });
}

describe('updates (#839)', () => {
  afterEach(() => vi.useRealTimers());

  it('downloads on Windows and Linux, then offers Restart to update', () => {
    const updater = fakeUpdater();
    const changed = vi.fn();
    const updates = new Updates(updater, { canInstall: true, enabled: () => true, changed });
    expect(updater.autoDownload).toBe(true);
    updater.emit('checking-for-update');
    expect(updates.state.status).toBe('checking');
    updater.emit('update-available', { version: '0.4.0' });
    expect(updates.state).toMatchObject({ status: 'downloading', version: '0.4.0', percent: 0 });
    updater.emit('download-progress', { percent: 41.6 });
    expect(updates.state.percent).toBe(42);
    updates.install();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    updater.emit('update-downloaded', { version: '0.4.0' });
    expect(updates.state).toMatchObject({ status: 'ready', version: '0.4.0' });
    // A daily check while one waits to be installed changes nothing.
    updates.check();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    updates.install();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalled();
  });

  it('only tells macOS which version is available', () => {
    const updater = fakeUpdater();
    const updates = new Updates(updater, { canInstall: false, enabled: () => true, changed() {} });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    updater.emit('update-available', { version: '0.4.0' });
    expect(updates.state).toMatchObject({ status: 'manual', version: '0.4.0', percent: null });
    // A failed later check keeps the version shown
    updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\nstack'));
    expect(updates.state).toMatchObject({
      status: 'manual',
      error: 'net::ERR_INTERNET_DISCONNECTED',
    });
  });

  it('checks on start and daily, only while automatic checks are on', () => {
    vi.useFakeTimers();
    const updater = fakeUpdater();
    let enabled = true;
    const updates = new Updates(updater, {
      canInstall: true,
      enabled: () => enabled,
      changed() {},
    });
    updates.start();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DAY);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    enabled = false;
    vi.advanceTimersByTime(DAY);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.emit('update-not-available', { version: '0.3.1' });
    expect(updates.state).toMatchObject({ status: 'idle', version: null });
  });
});

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open a URL in the user's default browser. Doesn't wait for the browser to
 * exit — it just hands off to the OS opener and resolves once that's spawned.
 */
export function openUrl(url: string): Promise<void> {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', rejectFn);
    child.on('spawn', () => {
      child.unref();
      resolveFn();
    });
  });
}

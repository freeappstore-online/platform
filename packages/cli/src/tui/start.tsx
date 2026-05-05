import { render } from 'ink';
import { App } from './App.js';

/**
 * Entry point for `fas` (no args) → renders the interactive TUI.
 * Awaits until the user quits (Ctrl-C, q, or via the menu).
 */
export async function startTui(): Promise<void> {
  const instance = render(<App />);
  await instance.waitUntilExit();
}

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTheme } from './hooks.js';
import { useTextSize } from './ui/core.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let theme: ReturnType<typeof useTheme>;
let text: ReturnType<typeof useTextSize>;
function Probe({ name }: { name: string }) {
  const appearance = useTheme();
  const size = useTextSize();
  if (name === 'first') {
    theme = appearance;
    text = size;
  }
  return (
    <output data-name={name}>
      {appearance.preference}:{appearance.theme}:{size.size}
    </output>
  );
}
const output = (name: string) => container.querySelector(`[data-name="${name}"]`)!.textContent;
beforeEach(async () => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe name="first" />));
  await act(async () => {
    theme.setPreference('system');
    text.setSize('default');
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('keeps all mounted text controls in sync', async () => {
  await act(async () =>
    root.render(
      <>
        <Probe name="first" />
        <Probe name="second" />
      </>,
    ),
  );
  await act(async () => text.setSize('lg'));
  expect(output('first')).toContain(':lg');
  expect(output('second')).toContain(':lg');
});

it('retains the selected theme and text size when storage writes fail', async () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('blocked');
  });
  await act(async () => {
    theme.setPreference('dark');
    text.setSize('lg');
  });
  expect(output('first')).toBe('dark:dark:lg');
  await act(async () =>
    root.render(
      <>
        <Probe name="first" />
        <Probe name="second" />
      </>,
    ),
  );
  expect(output('second')).toBe('dark:dark:lg');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.dataset.text).toBe('lg');
});

it('updates every control and the document after another tab changes preferences', async () => {
  await act(async () => {
    localStorage.setItem('stores-theme', 'dark');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'stores-theme',
        newValue: 'dark',
        storageArea: localStorage,
      }),
    );
    localStorage.setItem('stores-text-size', 'sm');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'stores-text-size',
        newValue: 'sm',
        storageArea: localStorage,
      }),
    );
  });
  expect(output('first')).toBe('dark:dark:sm');
  expect(document.documentElement.dataset.text).toBe('sm');
  await act(async () => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
  });
  expect(output('first')).toBe('system:light:default');
});

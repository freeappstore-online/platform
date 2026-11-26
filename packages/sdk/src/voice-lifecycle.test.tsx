// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useVoiceInput } from './voice.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('does not call onResult after unmount', async () => {
  const instances: FakeRecognition[] = [];
  class FakeRecognition {
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: ((event: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor() {
      instances.push(this);
    }
    start() {}
    stop() {}
    // Browsers fire onend after abort(), as on a real stop.
    abort() {
      this.onend?.();
    }
  }
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  const onResult = vi.fn();
  function Probe() {
    useVoiceInput(onResult);
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  const recognition = instances[0]!;
  await act(async () =>
    recognition.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: 'partial' } } },
    }),
  );
  await act(async () => root.unmount());
  expect(onResult).not.toHaveBeenCalled();
  expect(recognition.onend).toBeNull();
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
});

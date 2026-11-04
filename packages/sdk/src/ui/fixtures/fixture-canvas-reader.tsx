import { useRef } from 'react';
import type { FreeAppStore } from '../../index.js';
import { AccountSection } from '../profile.js';
import { ShellErrorBoundary, SkipLink, ToastProvider } from '../shell-resilience.js';

/** Focused canvas. Gesture locking stays on the canvas, and there is no nav item. */
export function CanvasReaderFixture({ app }: { app: FreeAppStore }) {
  const mainRef = useRef<HTMLElement>(null);
  return (
    <ToastProvider>
      <div className="flex min-h-[100dvh] flex-col">
        <SkipLink mainRef={mainRef} />
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
          <span className="truncate font-semibold text-ink">Sketch</span>
          <AccountSection app={app} />
        </header>
        <ShellErrorBoundary app={app} resetKey="/">
          <main id="main" ref={mainRef} tabIndex={-1} className="flex flex-1 flex-col">
            <canvas aria-label="Drawing canvas" className="touch-none h-[70dvh] w-full" />
          </main>
        </ShellErrorBoundary>
      </div>
    </ToastProvider>
  );
}

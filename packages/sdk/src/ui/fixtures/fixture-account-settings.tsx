import { useRef } from 'react';
import type { FreeAppStore } from '../../index.js';
import { PageHeader } from '../page.js';
import { AccountSection } from '../profile.js';
import { SkipLink, ToastProvider } from '../shell-resilience.js';

/** Settings page that embeds the account block and an app-owned field. */
export function AccountSettingsFixture({ app }: { app: FreeAppStore }) {
  const mainRef = useRef<HTMLElement>(null);
  return (
    <ToastProvider>
      <div className="flex min-h-[100dvh] flex-col">
        <SkipLink mainRef={mainRef} />
        <header className="border-b border-line px-4 py-3">
          <span className="font-semibold text-ink">Notes</span>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 px-4">
          <PageHeader title="Settings" />
          <AccountSection app={app}>
            <label className="flex flex-col gap-1 text-sm text-ink">
              Notebook name
              <input
                aria-label="Notebook name"
                defaultValue="Field notes"
                className="rounded-sm border border-line bg-panel p-2"
              />
            </label>
          </AccountSection>
        </main>
      </div>
    </ToastProvider>
  );
}

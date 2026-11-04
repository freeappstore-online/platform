import type { MouseEvent } from 'react';
import type { FreeAppStore } from '../../index.js';
import { canFollowLink } from '../navigation.js';
import { PageHeader } from '../page.js';
import { AccountSection } from '../profile.js';
import { ShellErrorBoundary, SkipLink, ToastProvider } from '../shell-resilience.js';
import { useInAppNavigate } from './router.js';

const ITEMS = [
  { label: 'Notes', href: '/' },
  { label: 'Tags', href: '/tags' },
];

/** Custom frame with the primary nav along the bottom. Detail routes add no item. */
export function BottomNavFixture({ app }: { app: FreeAppStore }) {
  const { location, mainRef, navigate } = useInAppNavigate();
  const follow = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!canFollowLink(event, href)) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <ToastProvider>
      <div className="flex min-h-[100dvh] flex-col pb-[env(safe-area-inset-bottom,0px)]">
        <SkipLink mainRef={mainRef} />
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
          <span className="truncate font-semibold text-ink">Notes</span>
          <AccountSection app={app} location={location} onNavigate={navigate} />
        </header>
        <ShellErrorBoundary app={app} resetKey={location}>
          <main id="main" ref={mainRef} tabIndex={-1} className="flex-1">
            <PageHeader title={location.startsWith('/tags') ? 'Tags' : 'Notes'} />
          </main>
        </ShellErrorBoundary>
        <nav aria-label="Main" className="sticky bottom-0 flex border-t border-line bg-panel">
          {ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="inline-flex min-h-11 flex-1 items-center justify-center text-ink no-underline"
              onClick={(event) => follow(event, item.href)}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </div>
    </ToastProvider>
  );
}

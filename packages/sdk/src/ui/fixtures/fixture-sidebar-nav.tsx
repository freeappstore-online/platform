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

/** Custom frame: one header, a sidebar nav, and the shared account block. */
export function SidebarNavFixture({ app }: { app: FreeAppStore }) {
  const { location, mainRef, navigate } = useInAppNavigate();
  const follow = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!canFollowLink(event, href)) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <ToastProvider>
      <div className="flex min-h-[100dvh]">
        <SkipLink mainRef={mainRef} />
        <nav
          aria-label="Main"
          className="flex w-56 shrink-0 flex-col gap-1 border-r border-line p-3"
        >
          {ITEMS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="inline-flex min-h-11 items-center rounded-sm px-3 text-ink no-underline"
              onClick={(event) => follow(event, item.href)}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
            <span className="truncate font-semibold text-ink">Notes</span>
            <AccountSection app={app} location={location} onNavigate={navigate} />
          </header>
          <ShellErrorBoundary app={app} resetKey={location}>
            <main id="main" ref={mainRef} tabIndex={-1} className="flex-1">
              <PageHeader title={location.startsWith('/tags') ? 'Tags' : 'Notes'} />
            </main>
          </ShellErrorBoundary>
        </div>
      </div>
    </ToastProvider>
  );
}

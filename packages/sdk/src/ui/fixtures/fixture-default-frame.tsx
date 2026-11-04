import type { FreeAppStore } from '../../index.js';
import { Shell } from '../layout.js';
import type { NavItem } from '../navbar.js';
import { PageHeader } from '../page.js';

const NAV: NavItem[] = [
  { label: 'Notes', href: '/', title: 'Notes' },
  { label: 'Tags', href: '/tags', title: 'Tags — Notes' },
];

/** Default Shell with an app button in the header control slot. */
export function DefaultFrameFixture({ app }: { app: FreeAppStore }) {
  return (
    <Shell
      app={app}
      appName="Notes"
      nav={NAV}
      headerActions={
        <button type="button" className="inline-flex min-h-11 items-center px-3">
          New
        </button>
      }
    >
      <PageHeader title="Notes" />
    </Shell>
  );
}

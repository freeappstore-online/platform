import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useAuth, useTheme } from '../hooks.js';
import type { FreeAppStore } from '../index.js';
import { Modal, Spinner } from './components.js';
import { Avatar, SignInButton, TextSizeToggle, ThemeToggle, useTextSize } from './core.js';
import { FriendRequestBadge, FriendsList } from './friends.js';
import { activeHref, NavBar, type NavItem, useCurrentPath } from './navbar.js';
import { PageHeader } from './page.js';
import {
  OfflineBanner,
  ShellErrorBoundary,
  type ShellErrorContext,
  SkipLink,
  ToastProvider,
  useRouteChangeEffects,
} from './shell-resilience.js';

// ---------------------------------------------------------------------------
// ProfileMenu
// ---------------------------------------------------------------------------

export interface ProfileMenuProps {
  app: FreeAppStore;
  showThemeToggle?: boolean;
  children?: ReactNode;
}

/** Avatar button that opens dropdown: username, theme toggle, sign out, delete account. */
export function ProfileMenu({ app, showThemeToggle = true, children }: ProfileMenuProps) {
  const { user, signOut, deleteAccount } = useAuth(app);
  const [open, setOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!user) return null;

  const handleSignOut = () => {
    signOut();
    setOpen(false);
  };
  const handleDelete = async () => {
    if (
      !confirm(
        'Delete your account? This permanently removes ALL your data across ALL apps. This cannot be undone.',
      )
    )
      return;
    if (!confirm('Are you absolutely sure? Last chance.')) return;
    await deleteAccount();
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Profile menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="bg-transparent border-2 border-line rounded-full p-0 cursor-pointer w-8 h-8 overflow-hidden block"
      >
        <Avatar user={user} size={28} />
      </button>
      {open && (
        <div className="absolute top-10 right-0 bg-popover border border-line rounded shadow-sm min-w-50 p-[0.5rem_0] z-[100]">
          <div className="p-[0.5rem_1rem] border-b border-line text-[0.85rem] font-bold text-ink">
            {user.login}
          </div>
          {showThemeToggle && (
            <div className="p-[0.5rem_1rem] border-b border-line flex items-center justify-between">
              <span className="text-[0.85rem] text-muted">Theme</span>
              <ThemeToggle />
            </div>
          )}
          <button
            onClick={() => {
              app.keys.manage();
              setOpen(false);
            }}
            className="block w-full p-[0.5rem_1rem] bg-transparent border-0 text-left text-[0.85rem] cursor-pointer text-ink font-[inherit]"
          >
            API Keys
          </button>
          <button
            onClick={() => {
              setFriendsOpen(true);
              setOpen(false);
            }}
            className="flex w-full p-[0.5rem_1rem] bg-transparent border-0 text-left text-[0.85rem] cursor-pointer text-ink font-[inherit] items-center justify-between"
          >
            Friends <FriendRequestBadge app={app} />
          </button>
          {children}
          <button
            onClick={handleSignOut}
            className="block w-full p-[0.5rem_1rem] bg-transparent border-0 text-left text-[0.85rem] cursor-pointer text-ink font-[inherit]"
          >
            Sign out
          </button>
          <button
            onClick={handleDelete}
            className="block w-full p-[0.5rem_1rem] bg-transparent border-0 text-left text-[0.85rem] cursor-pointer text-danger font-[inherit]"
          >
            Delete account
          </button>
        </div>
      )}
      <Modal
        open={friendsOpen}
        onClose={() => setFriendsOpen(false)}
        title="Friends"
        maxWidth={420}
      >
        <FriendsList app={app} />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProfilePage
// ---------------------------------------------------------------------------

export interface ProfilePageProps {
  app: FreeAppStore;
  showThemeToggle?: boolean;
}

/** Full-page profile & preferences: avatar, theme, text size, friends, sign out, delete. */
export function ProfilePage({ app, showThemeToggle = true }: ProfilePageProps) {
  const { user, loading, signOut, deleteAccount } = useAuth(app);
  const { preference, setPreference } = useTheme();
  const { size: textSize, setSize: setTextSize } = useTextSize();
  const [friendsOpen, setFriendsOpen] = useState(false);
  const deleting = useRef(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  if (loading) {
    return <div className="p-8 text-center text-muted">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="mx-auto w-full max-w-120 px-4 py-8">
        <PageHeader title="Profile" />
        <p className="text-muted mb-6">Sign in to manage your profile and account.</p>
        <div className="flex flex-col gap-3">
          <SignInButton app={app} provider="github" />
          <SignInButton app={app} provider="google" />
        </div>
      </div>
    );
  }

  const handleDelete = async () => {
    if (deleting.current) return;
    if (
      !confirm(
        'Delete your account? This permanently removes ALL your data across ALL apps. This cannot be undone.',
      )
    )
      return;
    if (!confirm('Are you absolutely sure? Last chance.')) return;
    deleting.current = true;
    setDeletePending(true);
    setDeleteError('');
    try {
      await deleteAccount();
    } catch {
      setDeleteError('Unable to delete your account. Please try again.');
    } finally {
      deleting.current = false;
      setDeletePending(false);
    }
  };

  const themeOptions: Array<{ value: 'light' | 'dark' | 'system'; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  const textSizeOptions: Array<{ value: 'default' | 'lg' | 'sm'; label: string }> = [
    { value: 'sm', label: 'Small' },
    { value: 'default', label: 'Default' },
    { value: 'lg', label: 'Large' },
  ];

  return (
    <div className="w-full max-w-120 m-[0_auto] p-[2rem_1rem]">
      <PageHeader title="Profile" />
      {/* Identity */}
      <div className="flex items-center gap-4 mb-8">
        <div className="shrink-0">
          <Avatar user={user} size={64} />
        </div>
        <div className="min-w-0">
          <div className="[overflow-wrap:anywhere] text-[1.25rem] font-bold text-ink-strong">
            {user.login}
          </div>
          <div className="text-[0.85rem] text-muted">FreeAppStore account</div>
        </div>
      </div>

      {/* Appearance */}
      <ProfileSection title="Appearance">
        {showThemeToggle && (
          <>
            <ProfileLabel>Theme</ProfileLabel>
            <div className="flex gap-2 mb-4">
              {themeOptions.map((opt) => (
                <ToggleButton
                  key={opt.value}
                  active={preference === opt.value}
                  onClick={() => setPreference(opt.value)}
                >
                  {opt.label}
                </ToggleButton>
              ))}
            </div>
          </>
        )}
        <ProfileLabel>Text Size</ProfileLabel>
        <div className="flex gap-2">
          {textSizeOptions.map((opt) => (
            <ToggleButton
              key={opt.value}
              active={textSize === opt.value}
              onClick={() => setTextSize(opt.value)}
            >
              {opt.label}
            </ToggleButton>
          ))}
        </div>
      </ProfileSection>

      {/* Friends */}
      <ProfileSection title="Friends">
        <button
          onClick={() => setFriendsOpen(true)}
          className="w-full p-3 rounded border border-line bg-panel text-ink text-[0.9rem] font-semibold cursor-pointer font-[inherit] flex items-center justify-between"
        >
          Manage Friends <FriendRequestBadge app={app} />
        </button>
      </ProfileSection>

      {/* API Keys */}
      <ProfileSection title="API Keys">
        <button
          onClick={() => app.keys.manage()}
          className="w-full p-3 rounded border border-line bg-panel text-ink text-[0.9rem] font-semibold cursor-pointer font-[inherit]"
        >
          Manage API Keys
        </button>
      </ProfileSection>

      {/* Account */}
      <button
        onClick={signOut}
        className="w-full p-3 rounded border border-line bg-panel text-ink text-[0.9rem] font-semibold cursor-pointer font-[inherit] mb-6"
      >
        Sign out
      </button>

      <div className="border border-danger rounded p-5">
        <div className="text-[0.9rem] font-bold text-danger mb-2">Danger zone</div>
        <p className="text-[0.85rem] text-muted mb-3">
          Permanently delete your account and all data across all apps.
        </p>
        <button
          type="button"
          disabled={deletePending}
          onClick={handleDelete}
          className="p-[0.5rem_1rem] rounded-sm border border-danger bg-transparent text-danger text-[0.85rem] font-semibold cursor-pointer font-[inherit]"
        >
          {deletePending ? 'Deleting...' : 'Delete account'}
        </button>
        {deleteError && (
          <p role="alert" className="mt-3 text-danger">
            {deleteError}
          </p>
        )}
      </div>

      <Modal
        open={friendsOpen}
        onClose={() => setFriendsOpen(false)}
        title="Friends"
        maxWidth={420}
      >
        <FriendsList app={app} />
      </Modal>
    </div>
  );
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-panel border border-line rounded p-5 mb-4">
      <div className="text-[0.9rem] font-bold mb-3 text-ink">{title}</div>
      {children}
    </div>
  );
}

function ProfileLabel({ children }: { children: ReactNode }) {
  return <div className="text-[0.75rem] font-semibold text-muted mb-[0.35rem]">{children}</div>;
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex-1',
        'p-2',
        'rounded-sm',
        active ? 'border-2 border-accent' : 'border border-line',
        active ? 'bg-accent-soft' : 'bg-transparent',
        active ? 'text-accent' : 'text-muted',
        active ? 'font-bold' : 'font-medium',
        'text-[0.85rem]',
        'cursor-pointer',
        'font-[inherit]',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shell (also exported as FasShell for backwards compatibility)
// ---------------------------------------------------------------------------

export interface ShellNavContext {
  items: NavItem[];
  /** The path the shell considers current (`location.pathname`, following back/forward). */
  currentPath: string;
  /** Navigate to `href`: the shell's `onNavigate`, else a full page load. */
  onNavigate: (href: string) => void;
}

export interface ShellProps {
  app: FreeAppStore;
  children: ReactNode;
  appName?: string;
  /**
   * The app's screens — the standard way to give an app navigation. Shell
   * renders them as a `<nav aria-label="Main">` in its topbar, marks the current
   * route, and collapses to a menu button on small screens.
   *
   * ```tsx
   * <Shell app={fas} appName="Notes" nav={[{ label: 'Notes', href: '/' }, { label: 'Tags', href: '/tags' }]}>
   * ```
   */
  nav?: NavItem[];
  /** Replace the built-in NavBar (still placed in the topbar) with your own. */
  renderNav?: (ctx: ShellNavContext) => ReactNode;
  /**
   * Client-side navigation for nav clicks (e.g. your router's `navigate`).
   * Without it, nav items are ordinary links (full page load).
   */
  onNavigate?: (href: string) => void;
  /** App-owned profile route for both auth states. Omit to use the built-in /profile page. */
  profileHref?: string;
  /**
   * Replace the fallback shown when a screen throws while rendering. The error
   * is already recorded via `app.log`; call `reset` to retry.
   */
  renderError?: (ctx: ShellErrorContext) => ReactNode;
  /** Replace the spinner shown while a lazy-loaded screen loads. */
  renderLoading?: () => ReactNode;
  requireAuth?: boolean;
  showThemeToggle?: boolean;
}

function routeUrl(href: string): URL {
  return new URL(
    href,
    typeof window === 'undefined' ? 'https://fas.invalid/' : window.location.href,
  );
}

/** Only allow an in-app return destination, never an off-site URL or a profile loop. */
function profileReturnHref(): string {
  if (typeof window === 'undefined') return '/';
  const candidate = new URLSearchParams(window.location.search).get('returnTo');
  if (!candidate?.startsWith('/') || candidate.startsWith('//')) return '/';
  try {
    const url = new URL(candidate, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.replace(/\/+$/, '') === '/profile')
      return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

function normalizeShellAppName(appName?: string) {
  return appName === 'AppStore' ? 'FreeAppStore' : appName;
}

/**
 * Full wrapper: skip link, sticky topbar with main navigation, offline banner,
 * main content (error boundary + Suspense), toast region, safe-area padding. Optional auth
 * gate. On client-side navigation (`onNavigate`) it scrolls to the top (or back
 * to where the route was left) and moves focus to the new screen's heading.
 */
export function Shell({
  app,
  children,
  appName,
  nav,
  renderNav,
  onNavigate,
  profileHref,
  renderError,
  renderLoading,
  requireAuth = false,
  showThemeToggle = true,
}: ShellProps) {
  const { user, loading } = useAuth(app);
  const [currentPath, setCurrentPath] = useCurrentPath();
  const mainRef = useRef<HTMLElement>(null);
  const initialTitle = useRef(typeof document === 'undefined' ? '' : document.title);
  const beforeNavigate = useRouteChangeEffects(currentPath, mainRef, !!onNavigate);
  const profileTarget = routeUrl(profileHref ?? '/profile');
  const isProfile =
    profileTarget.origin === routeUrl('/').origin &&
    currentPath.replace(/\/+$/, '') === profileTarget.pathname.replace(/\/+$/, '');
  const builtInProfile = !profileHref && isProfile;
  const currentHref =
    typeof window === 'undefined'
      ? '/'
      : window.location.pathname + window.location.search + window.location.hash;
  const profileLink =
    profileHref ??
    (isProfile
      ? currentHref
      : typeof window === 'undefined'
        ? '/profile'
        : `/profile?returnTo=${encodeURIComponent(currentHref)}`);
  const returnHref = profileReturnHref();
  const displayAppName = normalizeShellAppName(appName);
  // A nav item's `title` becomes the tab title on its route. A layout effect
  // runs before every passive effect, so a screen's own useDocumentTitle wins.
  const navItems = nav ?? [];
  const navTitle = builtInProfile
    ? `Profile${displayAppName ? ` — ${displayAppName}` : ''}`
    : (navItems.find((item) => item.href === activeHref(navItems, currentPath))?.title ??
      (!profileHref ? displayAppName || initialTitle.current : undefined));
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply on every route change, even when two routes share a title.
  useLayoutEffect(() => {
    if (navTitle !== undefined) document.title = navTitle;
  }, [navTitle, currentPath]);

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <p className="text-muted">Loading...</p>
      </div>
    );
  }

  // Client-side navigation goes through the shell so it knows the route changed.
  // Without onNavigate, items are plain links.
  const navigate = onNavigate
    ? (href: string) => {
        beforeNavigate();
        onNavigate(href);
        setCurrentPath(routeUrl(href).pathname);
      }
    : undefined;
  const openProfile = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      !navigate ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    if (isProfile) return;
    navigate(profileLink);
  };
  const navNode =
    navItems.length === 0 ? null : renderNav ? (
      renderNav({
        items: navItems,
        currentPath,
        onNavigate: navigate ?? ((href) => window.location.assign(href)),
      })
    ) : navigate ? (
      <NavBar items={navItems} currentPath={currentPath} onNavigate={navigate} />
    ) : (
      <NavBar items={navItems} />
    );

  const loadingNode = renderLoading ? (
    renderLoading()
  ) : (
    <div className="fas-shell-loading flex flex-1 items-center justify-center px-4 py-12">
      <Spinner size={28} />
    </div>
  );

  return (
    <ToastProvider>
      <div className="min-h-[100dvh] flex flex-col pb-[env(safe-area-inset-bottom,0px)]">
        <SkipLink mainRef={mainRef} />
        <header className="flex items-center justify-between p-[0.5rem_1rem] border-b border-line bg-panel sticky top-0 z-[50]">
          <div className="min-w-0">
            {appName && (
              <span className="block truncate text-[1rem] font-semibold text-ink">{appName}</span>
            )}
          </div>
          {navNode}
          <div className="flex shrink-0 items-center gap-2">
            <TextSizeToggle />
            {showThemeToggle && !user && <ThemeToggle />}
            <a
              href={profileLink}
              aria-label="Profile"
              aria-current={isProfile ? 'page' : undefined}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={openProfile}
            >
              <Avatar user={user} size={user ? 32 : 24} />
            </a>
          </div>
        </header>
        <OfflineBanner />
        <main id="main" ref={mainRef} tabIndex={-1} className="fas-main flex-1 flex flex-col">
          <ShellErrorBoundary app={app} renderError={renderError} resetKey={currentPath}>
            <Suspense fallback={loadingNode}>
              {builtInProfile ? (
                <>
                  <a
                    href={returnHref}
                    className="self-start m-4 text-accent underline"
                    onClick={(event) => {
                      if (
                        !navigate ||
                        event.defaultPrevented ||
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      navigate(returnHref);
                    }}
                  >
                    Back to app
                  </a>
                  <ProfilePage app={app} showThemeToggle={showThemeToggle} />
                </>
              ) : requireAuth && !user && !isProfile ? (
                <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
                  <h1 className="text-2xl font-bold text-ink mb-2">
                    {displayAppName || 'Welcome'}
                  </h1>
                  <p className="text-muted mb-4">Sign in to continue.</p>
                  <a href={profileLink} className="text-accent underline" onClick={openProfile}>
                    Open profile to sign in
                  </a>
                </div>
              ) : (
                children
              )}
            </Suspense>
          </ShellErrorBoundary>
        </main>
      </div>
    </ToastProvider>
  );
}

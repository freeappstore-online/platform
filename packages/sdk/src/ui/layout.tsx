import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Suspense,
  useLayoutEffect,
  useRef,
} from 'react';
import { useAuth } from '../hooks.js';
import type { FreeAppStore } from '../index.js';
import { Spinner } from './components.js';
import { Avatar, TextSizeToggle, ThemeToggle } from './core.js';
import { activeHref, NavBar, type NavItem } from './navbar.js';
import {
  canFollowLink,
  isLocalRoute,
  profileReturnHref,
  routeHref,
  routePath,
  routeUrl,
  useCurrentLocation,
} from './navigation.js';
import { ProfilePage } from './profile.js';
import {
  OfflineBanner,
  ShellErrorBoundary,
  type ShellErrorContext,
  SkipLink,
  ToastProvider,
  useRouteChangeEffects,
} from './shell-resilience.js';

export type { AccountSectionProps, ProfileMenuProps, ProfilePageProps } from './profile.js';
export { AccountSection, ProfileMenu, ProfilePage } from './profile.js';

// ---------------------------------------------------------------------------
// Shell (also exported as FasShell for backwards compatibility)
// ---------------------------------------------------------------------------

export interface ShellNavContext {
  items: NavItem[];
  /** The path the shell considers current (pathname, query and hash, following back/forward). */
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
   * Header control slot. Rendered in the topbar beside the profile avatar,
   * inside `[data-fas-header-actions]`. Put app buttons here instead of
   * patching the header DOM. The avatar stays a profile link.
   */
  headerActions?: ReactNode;
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
  headerActions,
  onNavigate,
  profileHref,
  renderError,
  renderLoading,
  requireAuth = false,
  showThemeToggle = true,
}: ShellProps) {
  const { user, loading } = useAuth(app);
  const [currentLocation, setCurrentLocation] = useCurrentLocation();
  const currentPath = routeUrl(currentLocation)?.pathname ?? '/';
  const mainRef = useRef<HTMLElement>(null);
  const initialTitle = useRef(typeof document === 'undefined' ? '' : document.title);
  const beforeNavigate = useRouteChangeEffects(currentLocation, mainRef, !!onNavigate);
  const profileTarget = routeUrl(profileHref ?? '/profile');
  const isProfile =
    isLocalRoute(profileTarget) &&
    routePath(currentPath) === routePath(profileTarget.pathname) &&
    (!profileHref ||
      ((!profileTarget.search || routeUrl(currentLocation)?.search === profileTarget.search) &&
        (!profileTarget.hash || routeUrl(currentLocation)?.hash === profileTarget.hash)));
  const builtInProfile = !profileHref && isProfile;
  const profileLink =
    (profileHref && profileTarget ? routeHref(profileTarget) : profileHref) ??
    (isProfile
      ? currentLocation
      : typeof window === 'undefined'
        ? '/profile'
        : `/profile?returnTo=${encodeURIComponent(currentLocation)}`);
  const returnHref = profileReturnHref(currentLocation);
  const displayAppName = normalizeShellAppName(appName);
  // A nav item's `title` becomes the tab title on its route. A layout effect
  // runs before every passive effect, so a screen's own useDocumentTitle wins.
  const navItems = nav ?? [];
  const navTitle = builtInProfile
    ? `Profile${displayAppName ? ` — ${displayAppName}` : ''}`
    : (navItems.find((item) => item.href === activeHref(navItems, currentLocation))?.title ??
      (!profileHref ? displayAppName || initialTitle.current : undefined));
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply on every route change, even when two routes share a title.
  useLayoutEffect(() => {
    if (navTitle !== undefined) document.title = navTitle;
  }, [navTitle, currentLocation]);

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
        const destination = routeUrl(href);
        if (!isLocalRoute(destination)) {
          window.location.assign(href);
          return;
        }
        beforeNavigate();
        onNavigate(routeHref(destination));
        setCurrentLocation(routeHref(destination));
      }
    : undefined;
  const openProfile = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!navigate || !canFollowLink(event, profileLink)) return;
    event.preventDefault();
    if (routeUrl(profileLink)?.href === routeUrl(currentLocation)?.href) return;
    navigate(profileLink);
  };
  const navNode =
    navItems.length === 0 ? null : renderNav ? (
      renderNav({
        items: navItems,
        currentPath: currentLocation,
        onNavigate: navigate ?? ((href) => window.location.assign(href)),
      })
    ) : (
      <NavBar
        items={navItems}
        currentPath={currentLocation}
        {...(navigate ? { onNavigate: navigate } : {})}
      />
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
        <header className="flex flex-wrap items-center justify-between gap-2 p-[0.5rem_1rem] border-b border-line bg-panel sticky top-0 z-[50]">
          <div className="min-w-0 flex-[1_1_auto]">
            {appName && (
              <span className="block [overflow-wrap:anywhere] text-[1rem] font-semibold text-ink">
                {appName}
              </span>
            )}
          </div>
          {navNode}
          <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2 [&>button]:min-h-[44px] [&>button]:min-w-[44px]">
            {/* Built-in Profile owns appearance settings. Custom profile routes retain header access. */}
            {profileHref && <TextSizeToggle />}
            {profileHref && showThemeToggle && <ThemeToggle />}
            {headerActions ? (
              <div
                data-fas-header-actions=""
                className="flex max-w-full min-w-0 flex-wrap items-center gap-2 [overflow-wrap:anywhere]"
              >
                {headerActions}
              </div>
            ) : null}
            <a
              href={profileLink}
              aria-label="Profile"
              aria-current={isProfile ? 'page' : undefined}
              className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              onClick={openProfile}
            >
              <Avatar user={user} size={user ? 32 : 24} />
            </a>
          </div>
        </header>
        <OfflineBanner />
        <main id="main" ref={mainRef} tabIndex={-1} className="fas-main flex-1 flex flex-col">
          <ShellErrorBoundary app={app} renderError={renderError} resetKey={currentLocation}>
            <Suspense fallback={loadingNode}>
              {builtInProfile ? (
                <>
                  <a
                    href={returnHref}
                    className="self-start m-4 text-accent underline"
                    onClick={(event) => {
                      if (!navigate || !canFollowLink(event, returnHref)) return;
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

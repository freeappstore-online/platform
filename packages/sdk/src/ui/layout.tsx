import {
  type CSSProperties,
  type ReactNode,
  Suspense,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useAuth, useTheme } from '../hooks.js';
import type { FreeAppStore } from '../index.js';
import { Footer, Modal, Spinner } from './components.js';
import { Avatar, SignInButton, TextSizeToggle, ThemeToggle, useTextSize } from './core.js';
import { FriendRequestBadge, FriendsList } from './friends.js';
import { activeHref, NavBar, type NavItem, useCurrentPath } from './navbar.js';
import {
  OfflineBanner,
  SHELL_CSS,
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
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: '2px solid var(--line)',
          borderRadius: '50%',
          padding: 0,
          cursor: 'pointer',
          width: 32,
          height: 32,
          overflow: 'hidden',
          display: 'block',
        }}
      >
        <Avatar user={user} size={28} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 40,
            right: 0,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius, 0.75rem)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
            minWidth: 200,
            padding: '0.5rem 0',
            zIndex: 100,
          }}
        >
          <div
            style={{
              padding: '0.5rem 1rem',
              borderBottom: '1px solid var(--line)',
              fontSize: '0.85rem',
              fontWeight: 700,
              color: 'var(--ink)',
            }}
          >
            {user.login}
          </div>
          {showThemeToggle && (
            <div
              style={{
                padding: '0.5rem 1rem',
                borderBottom: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Theme</span>
              <ThemeToggle />
            </div>
          )}
          <button
            onClick={() => {
              app.keys.manage();
              setOpen(false);
            }}
            style={menuItemStyle}
          >
            API Keys
          </button>
          <button
            onClick={() => {
              setFriendsOpen(true);
              setOpen(false);
            }}
            style={{
              ...menuItemStyle,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            Friends <FriendRequestBadge app={app} />
          </button>
          {children}
          <button onClick={handleSignOut} style={menuItemStyle}>
            Sign out
          </button>
          <button
            onClick={handleDelete}
            style={{ ...menuItemStyle, color: 'var(--danger, #dc2626)' }}
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

const menuItemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.5rem 1rem',
  background: 'none',
  border: 'none',
  textAlign: 'left',
  fontSize: '0.85rem',
  cursor: 'pointer',
  color: 'var(--ink)',
  fontFamily: 'inherit',
};

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

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>Loading...</div>
    );
  }

  if (!user) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>Sign in to view your profile.</p>
        <SignInButton app={app} />
      </div>
    );
  }

  const handleDelete = async () => {
    if (
      !confirm(
        'Delete your account? This permanently removes ALL your data across ALL apps. This cannot be undone.',
      )
    )
      return;
    if (!confirm('Are you absolutely sure? Last chance.')) return;
    await deleteAccount();
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
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem' }}>
      {/* Identity */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
        <Avatar user={user} size={64} />
        <div>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: 'var(--ink-strong)',
            }}
          >
            {user.login}
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>FreeAppStore account</div>
        </div>
      </div>

      {/* Appearance */}
      <ProfileSection title="Appearance">
        {showThemeToggle && (
          <>
            <ProfileLabel>Theme</ProfileLabel>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
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
        <div style={{ display: 'flex', gap: '0.5rem' }}>
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
          style={{
            ...profileBtnStyle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          Manage Friends <FriendRequestBadge app={app} />
        </button>
      </ProfileSection>

      {/* API Keys */}
      <ProfileSection title="API Keys">
        <button onClick={() => app.keys.manage()} style={profileBtnStyle}>
          Manage API Keys
        </button>
      </ProfileSection>

      {/* Account */}
      <button
        onClick={signOut}
        style={{
          ...profileBtnStyle,
          marginBottom: '1.5rem',
        }}
      >
        Sign out
      </button>

      <div
        style={{
          border: '1px solid #fecaca',
          borderRadius: 'var(--radius, 0.75rem)',
          padding: '1.25rem',
        }}
      >
        <div
          style={{
            fontSize: '0.9rem',
            fontWeight: 700,
            color: 'var(--danger, #dc2626)',
            marginBottom: '0.5rem',
          }}
        >
          Danger zone
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>
          Permanently delete your account and all data across all apps.
        </p>
        <button
          onClick={handleDelete}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: 'var(--radius-sm, 0.5rem)',
            border: '1px solid var(--danger, #dc2626)',
            background: 'transparent',
            color: 'var(--danger, #dc2626)',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Delete account
        </button>
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
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius, 0.75rem)',
        padding: '1.25rem',
        marginBottom: '1rem',
      }}
    >
      <div
        style={{
          fontSize: '0.9rem',
          fontWeight: 700,
          marginBottom: '0.75rem',
          color: 'var(--ink)',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ProfileLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: '0.75rem',
        fontWeight: 600,
        color: 'var(--muted)',
        marginBottom: '0.35rem',
      }}
    >
      {children}
    </div>
  );
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
      style={{
        flex: 1,
        padding: '0.5rem',
        borderRadius: 'var(--radius-sm, 0.5rem)',
        border: active ? '2px solid var(--accent)' : '1px solid var(--line)',
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
        fontWeight: active ? 700 : 500,
        fontSize: '0.85rem',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

const profileBtnStyle: CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  borderRadius: 'var(--radius, 0.75rem)',
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  color: 'var(--ink)',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

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
 * main content (error boundary + Suspense), toast region, footer. Optional auth
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
  renderError,
  renderLoading,
  requireAuth = false,
  showThemeToggle = true,
}: ShellProps) {
  const { user, loading } = useAuth(app);
  const [currentPath, setCurrentPath] = useCurrentPath();
  const mainRef = useRef<HTMLElement>(null);
  const beforeNavigate = useRouteChangeEffects(currentPath, mainRef, onNavigate !== undefined);
  const displayAppName = normalizeShellAppName(appName);

  useInsertionEffect(() => {
    if (document.getElementById('fas-shell-css')) return;
    const style = document.createElement('style');
    style.id = 'fas-shell-css';
    style.textContent = SHELL_CSS;
    document.head.appendChild(style);
  }, []);

  // A nav item's `title` becomes the tab title on its route. A layout effect
  // runs before every passive effect, so a screen's own useDocumentTitle wins.
  const navItems = nav ?? [];
  const navTitle = navItems.find((item) => item.href === activeHref(navItems, currentPath))?.title;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply on every route change, even when two routes share a title.
  useLayoutEffect(() => {
    if (navTitle) document.title = navTitle;
  }, [navTitle, currentPath]);

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p style={{ color: 'var(--muted)' }}>Loading...</p>
      </div>
    );
  }

  if (requireAuth && !user) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
        }}
      >
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 800,
              marginBottom: '0.5rem',
              color: 'var(--ink)',
            }}
          >
            {displayAppName || 'FreeAppStore'}
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Sign in to continue.
          </p>
          <SignInButton app={app} />
          <p style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '0.75rem' }}>
            One account for all Free apps.
          </p>
        </div>
      </div>
    );
  }

  // Client-side navigation goes through the shell so it knows the route changed.
  // Without onNavigate, items are plain links.
  const navigate = onNavigate
    ? (href: string) => {
        beforeNavigate();
        onNavigate(href);
        setCurrentPath(href);
      }
    : undefined;
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
    <div className="fas-shell-loading">
      <Spinner size={28} />
    </div>
  );

  return (
    <ToastProvider>
      <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
        <SkipLink mainRef={mainRef} />
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.5rem 1rem',
            borderBottom: '1px solid var(--line)',
            background: 'var(--panel)',
            position: 'sticky',
            top: 0,
            zIndex: 50,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <a
              href="https://freeappstore.online"
              style={{
                fontWeight: 800,
                fontSize: '1rem',
                color: 'var(--accent)',
                textDecoration: 'none',
              }}
            >
              Free
            </a>
            {displayAppName && displayAppName !== 'FreeAppStore' && (
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)' }}>
                {displayAppName}
              </span>
            )}
          </div>
          {navNode}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TextSizeToggle />
            {showThemeToggle && !user && <ThemeToggle />}
            {user ? (
              <ProfileMenu app={app} showThemeToggle={showThemeToggle} />
            ) : (
              <SignInButton app={app} label="Sign in" />
            )}
          </div>
        </header>
        <OfflineBanner />
        <main
          id="main"
          ref={mainRef}
          tabIndex={-1}
          className="fas-main"
          style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        >
          <ShellErrorBoundary app={app} renderError={renderError} resetKey={currentPath}>
            <Suspense fallback={loadingNode}>{children}</Suspense>
          </ShellErrorBoundary>
        </main>
        <Footer />
      </div>
    </ToastProvider>
  );
}

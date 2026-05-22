import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { FreeAppStore } from './index.js';
import type { User } from './types.js';
import { useAuth, useTheme } from './hooks.js';

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

export interface AvatarProps {
  user: User | null;
  size?: number;
}

/** GitHub avatar with fallback to colored initial circle. */
export function Avatar({ user, size = 32 }: AvatarProps) {
  if (user?.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.login}
        width={size}
        height={size}
        style={{
          borderRadius: '50%',
          display: 'block',
        }}
      />
    );
  }

  const initial = user?.login?.charAt(0).toUpperCase() ?? '?';
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--accent, #2563eb)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.45,
        fontWeight: 700,
      }}
    >
      {initial}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SignInButton
// ---------------------------------------------------------------------------

export interface SignInButtonProps {
  app: FreeAppStore;
  label?: string;
}

/** Platform-branded sign-in button. Calls app.auth.signIn(). */
export function SignInButton({ app, label = 'Sign in with GitHub' }: SignInButtonProps) {
  return (
    <button
      onClick={() => app.auth.signIn()}
      style={{
        background: 'var(--accent, #2563eb)',
        color: '#fff',
        border: 'none',
        padding: '0.6rem 1.5rem',
        borderRadius: 'var(--radius, 0.75rem)',
        fontSize: '0.9rem',
        fontWeight: 700,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ThemeToggle
// ---------------------------------------------------------------------------

/** Sun/moon toggle button. Cycles: system -> light -> dark. */
export function ThemeToggle() {
  const { theme, preference, setPreference } = useTheme();

  const cycle = useCallback(() => {
    const order: Array<'system' | 'light' | 'dark'> = ['system', 'light', 'dark'];
    const idx = order.indexOf(preference);
    setPreference(order[(idx + 1) % order.length]!);
  }, [preference, setPreference]);

  // Sun icon for dark mode, moon for light
  const icon = theme === 'dark' ? (
    // Sun
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  ) : (
    // Moon
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );

  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${preference}`}
      title={`Theme: ${preference}`}
      style={{
        width: 36,
        height: 36,
        borderRadius: 'var(--radius, 0.75rem)',
        border: '1px solid var(--border, #e2e8f0)',
        background: 'var(--surface, #ffffff)',
        color: 'var(--ink, #1e293b)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
        fontFamily: 'inherit',
      }}
    >
      {icon}
    </button>
  );
}

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
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!user) return null;

  const handleSignOut = () => { signOut(); setOpen(false); };
  const handleDelete = async () => {
    if (!confirm('Delete your account? This permanently removes ALL your data across ALL apps. This cannot be undone.')) return;
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
          border: '2px solid var(--border, #e2e8f0)',
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
        <div style={{
          position: 'absolute',
          top: 40,
          right: 0,
          background: 'var(--surface, #ffffff)',
          border: '1px solid var(--border, #e2e8f0)',
          borderRadius: 'var(--radius, 0.75rem)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
          minWidth: 200,
          padding: '0.5rem 0',
          zIndex: 100,
        }}>
          <div style={{
            padding: '0.5rem 1rem',
            borderBottom: '1px solid var(--border, #e2e8f0)',
            fontSize: '0.85rem',
            fontWeight: 700,
            color: 'var(--ink, #1e293b)',
          }}>
            {user.login}
          </div>
          {showThemeToggle && (
            <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border, #e2e8f0)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)' }}>Theme</span>
              <ThemeToggle />
            </div>
          )}
          {children}
          <button onClick={handleSignOut} style={menuItemStyle}>Sign out</button>
          <button onClick={handleDelete} style={{ ...menuItemStyle, color: '#dc2626' }}>Delete account</button>
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.5rem 1rem',
  background: 'none',
  border: 'none',
  textAlign: 'left',
  fontSize: '0.85rem',
  cursor: 'pointer',
  color: 'var(--ink, #1e293b)',
  fontFamily: 'inherit',
};

// ---------------------------------------------------------------------------
// ProfilePage
// ---------------------------------------------------------------------------

export interface ProfilePageProps {
  app: FreeAppStore;
  showThemeToggle?: boolean;
}

/** Full-page settings view: avatar, username, theme selector, sign out, delete account. */
export function ProfilePage({ app, showThemeToggle = true }: ProfilePageProps) {
  const { user, loading, signIn, signOut, deleteAccount } = useAuth(app);
  const { preference, setPreference } = useTheme();

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted, #64748b)' }}>Loading...</div>;
  }

  if (!user) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--muted, #64748b)', marginBottom: '1rem' }}>Sign in to view your profile.</p>
        <SignInButton app={app} />
      </div>
    );
  }

  const handleDelete = async () => {
    if (!confirm('Delete your account? This permanently removes ALL your data across ALL apps. This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? Last chance.')) return;
    await deleteAccount();
  };

  const themeOptions: Array<{ value: 'light' | 'dark' | 'system'; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '2rem 1rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
        <Avatar user={user} size={64} />
        <div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--ink-strong, var(--ink, #0f172a))' }}>{user.login}</div>
          <div style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)' }}>FreeAppStore account</div>
        </div>
      </div>

      {/* Theme preference */}
      {showThemeToggle && (
        <div style={{
          background: 'var(--surface, #ffffff)',
          border: '1px solid var(--border, #e2e8f0)',
          borderRadius: 'var(--radius, 0.75rem)',
          padding: '1.25rem',
          marginBottom: '1rem',
        }}>
          <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--ink, #1e293b)' }}>Appearance</div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {themeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPreference(opt.value)}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  borderRadius: 'var(--radius-sm, 0.5rem)',
                  border: preference === opt.value ? '2px solid var(--accent, #2563eb)' : '1px solid var(--border, #e2e8f0)',
                  background: preference === opt.value ? 'var(--accent-soft, #eff6ff)' : 'transparent',
                  color: preference === opt.value ? 'var(--accent, #2563eb)' : 'var(--muted, #64748b)',
                  fontWeight: preference === opt.value ? 700 : 500,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sign out */}
      <button
        onClick={signOut}
        style={{
          width: '100%',
          padding: '0.75rem',
          borderRadius: 'var(--radius, 0.75rem)',
          border: '1px solid var(--border, #e2e8f0)',
          background: 'var(--surface, #ffffff)',
          color: 'var(--ink, #1e293b)',
          fontSize: '0.9rem',
          fontWeight: 600,
          cursor: 'pointer',
          marginBottom: '1.5rem',
          fontFamily: 'inherit',
        }}
      >
        Sign out
      </button>

      {/* Danger zone */}
      <div style={{
        border: '1px solid #fecaca',
        borderRadius: 'var(--radius, 0.75rem)',
        padding: '1.25rem',
      }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#dc2626', marginBottom: '0.5rem' }}>Danger zone</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)', marginBottom: '0.75rem' }}>
          Permanently delete your account and all data across all apps.
        </p>
        <button
          onClick={handleDelete}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: 'var(--radius-sm, 0.5rem)',
            border: '1px solid #dc2626',
            background: 'transparent',
            color: '#dc2626',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Delete account
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FasShell
// ---------------------------------------------------------------------------

export interface FasShellProps {
  app: FreeAppStore;
  children: ReactNode;
  appName?: string;
  requireAuth?: boolean;
  showThemeToggle?: boolean;
}

/**
 * Full wrapper: sticky topbar (logo + app name + ProfileMenu or SignInButton),
 * main content area, "Part of FreeAppStore" footer. Optional auth gate.
 */
export function FasShell({ app, children, appName, requireAuth = false, showThemeToggle = true }: FasShellProps) {
  const { user, loading } = useAuth(app);

  if (loading) {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--muted, #64748b)' }}>Loading...</p>
    </div>;
  }

  if (requireAuth && !user) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem', color: 'var(--ink, #1e293b)' }}>
            {appName || 'FreeAppStore'}
          </h1>
          <p style={{ color: 'var(--muted, #64748b)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Sign in to continue.
          </p>
          <SignInButton app={app} />
          <p style={{ color: 'var(--muted, #64748b)', fontSize: '0.75rem', marginTop: '0.75rem' }}>
            One account for all Free apps.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      {/* Topbar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.5rem 1rem',
        borderBottom: '1px solid var(--border, #e2e8f0)',
        background: 'var(--surface, #ffffff)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <a
            href="https://freeappstore.online"
            style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--accent, #2563eb)', textDecoration: 'none' }}
          >
            Free
          </a>
          {appName && <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted, #64748b)' }}>{appName}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {showThemeToggle && !user && <ThemeToggle />}
          {user ? (
            <ProfileMenu app={app} showThemeToggle={showThemeToggle} />
          ) : (
            <SignInButton app={app} label="Sign in" />
          )}
        </div>
      </header>

      {/* App content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {children}
      </main>

      {/* Footer */}
      <footer style={{
        padding: '1rem',
        textAlign: 'center',
        fontSize: '0.75rem',
        color: 'var(--muted, #64748b)',
        borderTop: '1px solid var(--border, #e2e8f0)',
      }}>
        Part of{' '}
        <a
          href="https://freeappstore.online"
          style={{ color: 'var(--accent, #2563eb)', fontWeight: 600, textDecoration: 'none' }}
        >
          FreeAppStore
        </a>
      </footer>
    </div>
  );
}

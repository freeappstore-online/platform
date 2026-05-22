import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type CSSProperties } from 'react';
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
// TextSizeToggle
// ---------------------------------------------------------------------------

const TEXT_SIZE_KEY = 'stores-text-size';
type TextSize = 'default' | 'lg' | 'sm';

function getTextSize(): TextSize {
  if (typeof window === 'undefined') return 'default';
  const stored = window.localStorage.getItem(TEXT_SIZE_KEY);
  if (stored === 'lg' || stored === 'sm') return stored;
  return 'default';
}

function applyTextSize(size: TextSize): void {
  if (typeof document === 'undefined') return;
  if (size === 'default') {
    delete document.documentElement.dataset.text;
  } else {
    document.documentElement.dataset.text = size;
  }
}

/** Text size toggle. Cycles: default -> large -> small. Shows A/A+/A-. */
export function TextSizeToggle() {
  const [size, setSize] = useState<TextSize>(getTextSize);

  useEffect(() => {
    applyTextSize(size);
  }, [size]);

  const cycle = useCallback(() => {
    const order: TextSize[] = ['default', 'lg', 'sm'];
    const idx = order.indexOf(size);
    const next = order[(idx + 1) % order.length]!;
    setSize(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TEXT_SIZE_KEY, next);
    }
  }, [size]);

  const label = size === 'lg' ? 'A+' : size === 'sm' ? 'A\u2212' : 'A';
  const title = size === 'lg' ? 'Text: large' : size === 'sm' ? 'Text: small' : 'Text: default';

  return (
    <button
      onClick={cycle}
      aria-label={title}
      title={title}
      style={{
        width: 36,
        height: 36,
        borderRadius: 'var(--radius, 0.75rem)',
        border: '1px solid var(--line, var(--border, #e2e8f0))',
        background: 'var(--panel, var(--surface, #ffffff))',
        color: 'var(--ink, #1e293b)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        padding: 0,
        fontFamily: 'inherit',
        fontSize: '0.85rem',
        fontWeight: 700,
      }}
    >
      {label}
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
          <button onClick={() => { app.keys.manage(); setOpen(false); }} style={menuItemStyle}>
            API Keys
          </button>
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
          <TextSizeToggle />
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

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export interface SpinnerProps {
  size?: number;
  color?: string;
}

/** Animated border spinner. */
export function Spinner({ size = 24, color = 'var(--accent, #2563eb)' }: SpinnerProps) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `2px solid var(--border, #e2e8f0)`,
        borderTopColor: color,
        borderRadius: '50%',
        animation: 'fas-spin 0.6s linear infinite',
      }}
    />
  );
}

// Inject keyframes once
if (typeof document !== 'undefined' && !document.getElementById('fas-ui-keyframes')) {
  const style = document.createElement('style');
  style.id = 'fas-ui-keyframes';
  style.textContent = '@keyframes fas-spin{to{transform:rotate(360deg)}}@keyframes fas-fade-in{from{opacity:0}to{opacity:1}}@keyframes fas-slide-up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}';
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
  style?: CSSProperties;
}

const badgeColors: Record<string, { bg: string; color: string; border: string }> = {
  default: { bg: 'var(--surface, #f8fafc)', color: 'var(--muted, #64748b)', border: 'var(--border, #e2e8f0)' },
  accent: { bg: 'var(--accent-soft, #eff6ff)', color: 'var(--accent, #2563eb)', border: 'var(--accent, #2563eb)' },
  success: { bg: '#f0fdf4', color: '#16a34a', border: '#86efac' },
  warning: { bg: '#fefce8', color: '#ca8a04', border: '#fde047' },
  danger: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
};

/** Small pill badge for status, tags, counts. */
export function Badge({ children, variant = 'default', style: extraStyle }: BadgeProps) {
  const c = badgeColors[variant] ?? badgeColors.default!;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.25rem',
      padding: '0.15rem 0.5rem',
      borderRadius: '9999px',
      fontSize: '0.75rem',
      fontWeight: 600,
      lineHeight: 1.4,
      background: c.bg,
      color: c.color,
      border: `1px solid ${c.border}`,
      ...extraStyle,
    }}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface CardProps {
  children: ReactNode;
  onClick?: () => void;
  padding?: string;
  style?: CSSProperties;
}

/** Bordered surface card. Clickable if onClick is provided. */
export function Card({ children, onClick, padding = '1rem', style: extraStyle }: CardProps) {
  const interactive = !!onClick;
  const Tag = interactive ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding,
        borderRadius: 'var(--radius, 0.75rem)',
        border: '1px solid var(--border, var(--line, #e2e8f0))',
        background: 'var(--surface, var(--panel, #ffffff))',
        cursor: interactive ? 'pointer' : undefined,
        fontFamily: 'inherit',
        fontSize: 'inherit',
        color: 'inherit',
        transition: 'border-color 0.15s',
        ...(interactive ? { outline: 'none' } : {}),
        ...extraStyle,
      }}
    >
      {children}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface TabsProps {
  tabs: Array<{ key: string; label: string }>;
  active: string;
  onChange: (key: string) => void;
  style?: CSSProperties;
}

/** Pill-style tab selector. */
export function Tabs({ tabs, active, onChange, style: extraStyle }: TabsProps) {
  return (
    <div style={{
      display: 'inline-flex',
      gap: '0.25rem',
      padding: '0.25rem',
      borderRadius: '9999px',
      border: '1px solid var(--border, var(--line, #e2e8f0))',
      background: 'var(--surface, var(--glass, #f8fafc))',
      ...extraStyle,
    }}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          style={{
            padding: '0.35rem 0.85rem',
            borderRadius: '9999px',
            border: 'none',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
            background: active === tab.key ? 'var(--ink, #1e293b)' : 'transparent',
            color: active === tab.key ? 'var(--surface, #ffffff)' : 'var(--muted, #64748b)',
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
  maxWidth?: number;
}

/** Centered modal with backdrop. Closes on backdrop click or Escape. */
export function Modal({ open, onClose, children, title, maxWidth = 480 }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999,
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        animation: 'fas-fade-in 0.15s',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, var(--panel, #ffffff))',
          border: '1px solid var(--border, var(--line, #e2e8f0))',
          borderRadius: 'var(--radius-lg, var(--radius, 0.75rem))',
          maxWidth,
          width: '100%',
          maxHeight: '85dvh',
          overflow: 'auto',
          animation: 'fas-slide-up 0.2s',
        }}
      >
        {title && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border, var(--line, #e2e8f0))',
          }}>
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--ink, #1e293b)' }}>{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem', color: 'var(--muted, #64748b)', fontSize: '1.25rem', lineHeight: 1, fontFamily: 'inherit' }}
            >
              &times;
            </button>
          </div>
        )}
        <div style={{ padding: '1.25rem' }}>{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfirmDialog
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'default';
}

/** Confirm/cancel dialog built on Modal. */
export function ConfirmDialog({ open, onConfirm, onCancel, title, message, confirmLabel = 'Confirm', variant = 'default' }: ConfirmDialogProps) {
  const isDanger = variant === 'danger';
  return (
    <Modal open={open} onClose={onCancel} title={title} maxWidth={400}>
      <p style={{ fontSize: '0.9rem', color: 'var(--muted, #64748b)', margin: '0 0 1.25rem' }}>{message}</p>
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm, 0.5rem)',
            border: '1px solid var(--border, #e2e8f0)', background: 'transparent',
            color: 'var(--ink, #1e293b)', fontSize: '0.85rem', fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          style={{
            padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm, 0.5rem)',
            border: 'none', fontSize: '0.85rem', fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit',
            background: isDanger ? '#dc2626' : 'var(--accent, #2563eb)',
            color: '#fff',
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  icon?: ReactNode;
  title?: string;
  message: string;
  action?: ReactNode;
}

/** Centered empty-state placeholder. */
export function EmptyState({ icon, title, message, action }: EmptyStateProps) {
  return (
    <div style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
      {icon && <div style={{ marginBottom: '0.75rem', color: 'var(--muted, #94a3b8)', fontSize: '2rem' }}>{icon}</div>}
      {title && <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--ink, #1e293b)', marginBottom: '0.35rem' }}>{title}</div>}
      <p style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)', margin: '0 0 1rem', maxWidth: 320, marginInline: 'auto' }}>{message}</p>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

export interface ProgressBarProps {
  value: number;
  max?: number;
  color?: string;
  height?: number;
  label?: string;
}

/** Horizontal progress bar with optional label. */
export function ProgressBar({ value, max = 100, color = 'var(--accent, #2563eb)', height = 8, label }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div>
      {label && <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--muted, #64748b)', marginBottom: '0.35rem' }}>{label}</div>}
      <div style={{
        width: '100%', height, borderRadius: height,
        background: 'var(--border, var(--line, #e2e8f0))', overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: height,
          background: color, transition: 'width 0.3s',
        }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SearchInput
// ---------------------------------------------------------------------------

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: CSSProperties;
}

/** Search input with magnifying glass icon. */
export function SearchInput({ value, onChange, placeholder = 'Search...', style: extraStyle }: SearchInputProps) {
  return (
    <div style={{ position: 'relative', ...extraStyle }}>
      <svg
        width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
      >
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '0.5rem 0.75rem 0.5rem 2.25rem',
          borderRadius: '9999px',
          border: '1px solid var(--border, var(--line, #e2e8f0))',
          background: 'var(--surface, var(--glass, #ffffff))',
          color: 'var(--ink, #1e293b)',
          fontSize: '0.85rem',
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ListRow
// ---------------------------------------------------------------------------

export interface ListRowProps {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onClick?: () => void;
}

/** Clickable list row with icon, title, subtitle, and trailing content. */
export function ListRow({ icon, title, subtitle, trailing, onClick }: ListRowProps) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        width: '100%',
        padding: '0.65rem 0.75rem',
        background: 'none',
        border: 'none',
        borderBottom: '1px solid var(--border, var(--line, #e2e8f0))',
        textAlign: 'left',
        cursor: onClick ? 'pointer' : undefined,
        fontFamily: 'inherit',
        color: 'inherit',
      }}
    >
      {icon && <div style={{ flexShrink: 0, color: 'var(--muted, #64748b)' }}>{icon}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--ink, #1e293b)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
        {subtitle && <div style={{ fontSize: '0.75rem', color: 'var(--muted, #64748b)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div>}
      </div>
      {trailing && <div style={{ flexShrink: 0 }}>{trailing}</div>}
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render errors and shows a fallback. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          <p style={{ color: '#dc2626', fontWeight: 700, marginBottom: '0.5rem' }}>Something went wrong</p>
          <p style={{ color: 'var(--muted, #64748b)', fontSize: '0.85rem' }}>{this.state.error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// KeyPrompt
// ---------------------------------------------------------------------------

export interface KeyPromptProps {
  app: FreeAppStore;
  provider: string;
  providerName?: string;
  message?: string;
}

/**
 * Drop-in prompt shown when an app needs a user's API key.
 * Renders a card with a message and a button that redirects to
 * the platform key management page.
 *
 * Usage:
 *   if (!(await fas.keys.has('openai'))) {
 *     return <KeyPrompt app={fas} provider="openai" providerName="OpenAI" />;
 *   }
 */
export function KeyPrompt({ app, provider, providerName, message }: KeyPromptProps) {
  const name = providerName ?? provider;
  const msg = message ?? `This app uses ${name} and needs your API key. Your key is stored securely on the FreeAppStore platform and is never visible to the app.`;
  return (
    <div style={{
      background: 'var(--surface, var(--panel, #f8fafc))',
      border: '1px solid var(--border, var(--line, #e2e8f0))',
      borderRadius: 'var(--radius, 0.75rem)',
      padding: '1.5rem',
      maxWidth: 420,
      margin: '2rem auto',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--muted, #64748b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      </div>
      <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--ink, #1e293b)', marginBottom: '0.5rem' }}>
        {name} API key required
      </div>
      <p style={{ fontSize: '0.85rem', color: 'var(--muted, #64748b)', margin: '0 0 1rem', lineHeight: 1.5 }}>
        {msg}
      </p>
      <button
        onClick={() => app.keys.manage(provider)}
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
        Configure {name} key
      </button>
    </div>
  );
}

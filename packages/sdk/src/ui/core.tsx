import { useState, useEffect, useCallback } from 'react';
import type { FreeAppStore } from '../index.js';
import type { User } from '../types.js';
import { useTheme } from '../hooks.js';

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

  const icon = theme === 'dark' ? (
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

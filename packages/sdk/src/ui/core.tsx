import { useCallback, useEffect, useState } from 'react';
import type { AuthProvider } from '../auth.js';
import { useTheme } from '../hooks.js';
import type { FreeAppStore } from '../index.js';
import type { User } from '../types.js';

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

export interface AvatarProps {
  user: User | null;
  size?: number;
}

/** Account avatar, initial fallback, or a generic profile icon when signed out. */
export function Avatar({ user, size = 32 }: AvatarProps) {
  if (user?.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.login}
        width={size}
        height={size}
        className="rounded-full block"
      />
    );
  }

  if (!user) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="8" r="4" />
        <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
      </svg>
    );
  }
  const initial = user.login.charAt(0).toUpperCase();
  return (
    <div
      className="rounded-full bg-accent text-white flex items-center justify-center font-bold"
      // Dynamic: Avatar dimensions and initial font size follow the caller size prop.
      style={{ width: size, height: size, fontSize: size * 0.45 }}
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
  provider?: Exclude<AuthProvider, 'email'>;
  /** Use an avatar icon below the medium breakpoint for compact header layouts. */
  compactOnMobile?: boolean;
}

/** Sign-in action for the selected OAuth provider (GitHub by default). */
export function SignInButton({
  app,
  provider = 'github',
  label = `Sign in with ${{ github: 'GitHub', google: 'Google', apple: 'Apple' }[provider]}`,
  compactOnMobile = false,
}: SignInButtonProps) {
  return (
    <button
      type="button"
      onClick={() => app.auth.signIn(provider)}
      aria-label={label}
      title={compactOnMobile ? label : undefined}
      className={
        compactOnMobile
          ? 'w-9 h-9 shrink-0 rounded-full border border-line bg-panel text-ink inline-flex items-center justify-center p-0 md:w-auto md:h-auto md:rounded md:border-0 md:bg-accent md:text-white md:p-[0.6rem_1.5rem] text-[0.9rem] font-bold cursor-pointer font-[inherit]'
          : 'bg-accent text-white border-0 p-[0.6rem_1.5rem] rounded text-[0.9rem] font-bold cursor-pointer font-[inherit]'
      }
    >
      {compactOnMobile ? (
        <>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="md:hidden"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
          </svg>
          <span className="hidden md:inline">{label}</span>
        </>
      ) : (
        label
      )}
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

  const icon =
    theme === 'dark' ? (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
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
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );

  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${preference}`}
      title={`Theme: ${preference}`}
      className="w-9 h-9 rounded border border-line bg-panel text-ink inline-flex items-center justify-center cursor-pointer p-0 font-[inherit]"
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
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(TEXT_SIZE_KEY);
  } catch {} // storage blocked
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

/** Hook for text size state. Used by TextSizeToggle and ProfilePage. */
export function useTextSize() {
  const [size, setSize] = useState<TextSize>(getTextSize);

  useEffect(() => {
    applyTextSize(size);
  }, [size]);

  const set = useCallback((next: TextSize) => {
    setSize(next);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(TEXT_SIZE_KEY, next);
      } catch {} // storage blocked: the size applies but isn't saved
    }
  }, []);

  return { size, setSize: set };
}

/** Text size toggle. Cycles: default -> large -> small. Shows A/A+/A-. */
export function TextSizeToggle() {
  const { size, setSize } = useTextSize();

  const cycle = useCallback(() => {
    const order: TextSize[] = ['default', 'lg', 'sm'];
    const idx = order.indexOf(size);
    setSize(order[(idx + 1) % order.length]!);
  }, [size, setSize]);

  const label = size === 'lg' ? 'A+' : size === 'sm' ? 'A\u2212' : 'A';
  const title = size === 'lg' ? 'Text: large' : size === 'sm' ? 'Text: small' : 'Text: default';

  return (
    <button
      onClick={cycle}
      aria-label={title}
      title={title}
      className="w-9 h-9 rounded border border-line bg-panel text-ink inline-flex items-center justify-center cursor-pointer p-0 font-[inherit] text-[0.85rem] font-bold"
    >
      {label}
    </button>
  );
}

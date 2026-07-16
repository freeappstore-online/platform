import { Component, type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import type { FreeAppStore } from '../index.js';

// Inject keyframes once
if (typeof document !== 'undefined' && !document.getElementById('fas-ui-keyframes')) {
  const style = document.createElement('style');
  style.id = 'fas-ui-keyframes';
  style.textContent =
    '@keyframes fas-spin{to{transform:rotate(360deg)}}@keyframes fas-fade-in{from{opacity:0}to{opacity:1}}@keyframes fas-slide-up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}';
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export interface SpinnerProps {
  size?: number;
  color?: string;
}

export function Spinner({ size = 24, color = 'var(--accent)' }: SpinnerProps) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: '2px solid var(--line)',
        borderTopColor: color,
        borderRadius: '50%',
        animation: 'fas-spin 0.6s linear infinite',
      }}
    />
  );
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
  default: {
    bg: 'var(--panel)',
    color: 'var(--muted)',
    border: 'var(--line)',
  },
  accent: {
    bg: 'var(--accent-soft)',
    color: 'var(--accent)',
    border: 'var(--accent)',
  },
  success: { bg: '#f0fdf4', color: '#16a34a', border: '#86efac' },
  warning: { bg: '#fefce8', color: '#ca8a04', border: '#fde047' },
  danger: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
};

export function Badge({ children, variant = 'default', style: extraStyle }: BadgeProps) {
  const c = badgeColors[variant] ?? badgeColors.default!;
  return (
    <span
      style={{
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
      }}
    >
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
        border: '1px solid var(--line)',
        background: 'var(--panel)',
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

export function Tabs({ tabs, active, onChange, style: extraStyle }: TabsProps) {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: '0.25rem',
        padding: '0.25rem',
        borderRadius: '9999px',
        border: '1px solid var(--line)',
        background: 'var(--panel)',
        ...extraStyle,
      }}
    >
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
            background: active === tab.key ? 'var(--ink)' : 'transparent',
            color: active === tab.key ? 'var(--panel)' : 'var(--muted)',
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

export function Modal({ open, onClose, children, title, maxWidth = 480 }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
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
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg, var(--radius, 0.75rem))',
          maxWidth,
          width: '100%',
          maxHeight: '85dvh',
          overflow: 'auto',
          animation: 'fas-slide-up 0.2s',
        }}
      >
        {title && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '1rem 1.25rem',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <h2
              style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--ink)' }}
            >
              {title}
            </h2>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '0.25rem',
                color: 'var(--muted)',
                fontSize: '1.25rem',
                lineHeight: 1,
                fontFamily: 'inherit',
              }}
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

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  message,
  confirmLabel = 'Confirm',
  variant = 'default',
}: ConfirmDialogProps) {
  const isDanger = variant === 'danger';
  return (
    <Modal open={open} onClose={onCancel} title={title} maxWidth={400}>
      <p style={{ fontSize: '0.9rem', color: 'var(--muted)', margin: '0 0 1.25rem' }}>
        {message}
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: 'var(--radius-sm, 0.5rem)',
            border: '1px solid var(--line)',
            background: 'transparent',
            color: 'var(--ink)',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: 'var(--radius-sm, 0.5rem)',
            border: 'none',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: isDanger ? '#dc2626' : 'var(--accent)',
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

export function EmptyState({ icon, title, message, action }: EmptyStateProps) {
  return (
    <div style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
      {icon && (
        <div style={{ marginBottom: '0.75rem', color: 'var(--muted)', fontSize: '2rem' }}>
          {icon}
        </div>
      )}
      {title && (
        <div
          style={{
            fontSize: '1rem',
            fontWeight: 700,
            color: 'var(--ink)',
            marginBottom: '0.35rem',
          }}
        >
          {title}
        </div>
      )}
      <p
        style={{
          fontSize: '0.85rem',
          color: 'var(--muted)',
          margin: '0 0 1rem',
          maxWidth: 320,
          marginInline: 'auto',
        }}
      >
        {message}
      </p>
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

export function ProgressBar({
  value,
  max = 100,
  color = 'var(--accent)',
  height = 8,
  label,
}: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div>
      {label && (
        <div
          style={{
            fontSize: '0.75rem',
            fontWeight: 600,
            color: 'var(--muted)',
            marginBottom: '0.35rem',
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          width: '100%',
          height,
          borderRadius: height,
          background: 'var(--line)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: height,
            background: color,
            transition: 'width 0.3s',
          }}
        />
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

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  style: extraStyle,
}: SearchInputProps) {
  return (
    <div style={{ position: 'relative', ...extraStyle }}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--muted)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          position: 'absolute',
          left: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
        }}
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
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
          border: '1px solid var(--line)',
          background: 'var(--panel)',
          color: 'var(--ink)',
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
        borderBottom: '1px solid var(--line)',
        textAlign: 'left',
        cursor: onClick ? 'pointer' : undefined,
        fontFamily: 'inherit',
        color: 'inherit',
      }}
    >
      {icon && <div style={{ flexShrink: 0, color: 'var(--muted)' }}>{icon}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.9rem',
            fontWeight: 600,
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              fontSize: '0.75rem',
              color: 'var(--muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subtitle}
          </div>
        )}
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

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <p style={{ color: '#dc2626', fontWeight: 700, marginBottom: '0.5rem' }}>
              Something went wrong
            </p>
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
              {this.state.error.message}
            </p>
          </div>
        )
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

// ---------------------------------------------------------------------------
// BuildInfo
// ---------------------------------------------------------------------------

export interface BuildInfoProps {
  version?: string;
  commit?: string;
  buildDate?: string;
  extra?: Record<string, string>;
}

/**
 * Tiny debug badge showing build version, commit SHA, and build date.
 * Hidden by default, revealed by tapping 5 times (mobile) or clicking
 * while holding Alt/Option (desktop). Sticks to the bottom-right corner.
 *
 * Reads from Vite env vars automatically if no props are passed:
 *   VITE_APP_VERSION, VITE_COMMIT_SHA, VITE_BUILD_DATE
 *
 * Add to deploy.yml:
 *   env:
 *     VITE_APP_VERSION: ${{ github.event.repository.name }}@${{ github.run_number }}
 *     VITE_COMMIT_SHA: ${{ github.sha }}
 *     VITE_BUILD_DATE: ${{ github.event.head_commit.timestamp }}
 */
export function BuildInfo({ version, commit, buildDate, extra }: BuildInfoProps) {
  const [visible, setVisible] = useState(false);
  const [tapCount, setTapCount] = useState(0);

  // Auto-read from Vite env vars if props not provided
  const env = typeof import.meta !== 'undefined' ? ((import.meta as any).env ?? {}) : {};
  const v = version ?? env.VITE_APP_VERSION ?? '';
  const sha = commit ?? env.VITE_COMMIT_SHA ?? '';
  const date = buildDate ?? env.VITE_BUILD_DATE ?? '';

  const handleClick = (e: React.MouseEvent) => {
    if (e.altKey) {
      setVisible(!visible);
      return;
    }
    const next = tapCount + 1;
    if (next >= 5) {
      setVisible(!visible);
      setTapCount(0);
    } else {
      setTapCount(next);
      setTimeout(() => setTapCount(0), 2000);
    }
  };

  if (!v && !sha && !date) return null;

  return (
    <>
      {/* Invisible tap target in bottom-right corner */}
      <div
        onClick={handleClick}
        style={{
          position: 'fixed',
          bottom: 8,
          right: 8,
          width: 24,
          height: 24,
          zIndex: 9999,
          cursor: 'default',
          opacity: 0,
        }}
        aria-hidden="true"
      />
      {visible && (
        <div
          onClick={() => setVisible(false)}
          style={{
            position: 'fixed',
            bottom: 8,
            right: 8,
            zIndex: 9999,
            background: 'rgba(0,0,0,0.85)',
            color: '#e5e5e5',
            padding: '0.5rem 0.75rem',
            borderRadius: '0.5rem',
            fontSize: '0.7rem',
            fontFamily: 'monospace',
            lineHeight: 1.6,
            maxWidth: 280,
            cursor: 'pointer',
            animation: 'fas-fade-in 0.15s',
          }}
        >
          {v && (
            <div>
              <span style={{ color: '#94a3b8' }}>version </span>
              {v}
            </div>
          )}
          {sha && (
            <div>
              <span style={{ color: '#94a3b8' }}>commit </span>
              {sha.slice(0, 7)}
            </div>
          )}
          {date && (
            <div>
              <span style={{ color: '#94a3b8' }}>built </span>
              {new Date(date).toLocaleString()}
            </div>
          )}
          {extra &&
            Object.entries(extra).map(([k, val]) => (
              <div key={k}>
                <span style={{ color: '#94a3b8' }}>{k.padEnd(8)}</span>
                {val}
              </div>
            ))}
          <div style={{ color: 'var(--muted)', marginTop: '0.25rem', fontSize: '0.6rem' }}>
            tap to dismiss
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

export interface FooterProps {
  /** Override the default "Part of FreeAppStore" text. */
  text?: string;
}

/**
 * Fixed bottom footer for PWA standalone mode. Shows "Part of FreeAppStore"
 * branding and creates safe-area padding so app content doesn't sit in the
 * iPhone home indicator / Siri zone.
 *
 * **Only renders when installed to home screen** (standalone display mode).
 * Hidden in regular browser tabs where the browser already provides its own
 * bottom chrome. This prevents accidental Siri activations on iPhones when
 * users tap near the bottom of the screen.
 *
 * The Shell component includes this automatically. Use Footer directly only
 * if you're building a custom layout without Shell.
 */
export function Footer({ text }: FooterProps) {
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(display-mode: standalone)');
    const check = () => {
      setIsStandalone(
        mq.matches || (navigator as unknown as { standalone?: boolean }).standalone === true,
      );
    };
    check();
    mq.addEventListener('change', check);
    return () => mq.removeEventListener('change', check);
  }, []);

  if (!isStandalone) return null;

  return (
    <footer
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 900,
        textAlign: 'center',
        background: 'var(--panel)',
        borderTop: '1px solid var(--line)',
        paddingTop: '0.5rem',
        paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      <a
        href="https://freeappstore.online"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: '0.65rem',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
          textDecoration: 'none',
        }}
      >
        {text ?? 'Part of FreeAppStore'}
      </a>
    </footer>
  );
}

/**
 * Returns true when the app is running in PWA standalone mode (installed
 * to home screen). Use this to add bottom padding to your content area
 * so it doesn't sit behind the Footer.
 */
export function useStandalone(): boolean {
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(display-mode: standalone)');
    const check = () => {
      setStandalone(
        mq.matches || (navigator as unknown as { standalone?: boolean }).standalone === true,
      );
    };
    check();
    mq.addEventListener('change', check);
    return () => mq.removeEventListener('change', check);
  }, []);

  return standalone;
}

export function KeyPrompt({ app, provider, providerName, message }: KeyPromptProps) {
  const name = providerName ?? provider;
  const msg =
    message ??
    `This app uses ${name} and needs your API key. Your key is stored securely on the FreeAppStore platform and is never visible to the app.`;
  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius, 0.75rem)',
        padding: '1.5rem',
        maxWidth: 420,
        margin: '2rem auto',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ display: 'inline-block', verticalAlign: 'middle' }}
        >
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      </div>
      <div
        style={{
          fontSize: '1rem',
          fontWeight: 700,
          color: 'var(--ink)',
          marginBottom: '0.5rem',
        }}
      >
        {name} API key required
      </div>
      <p
        style={{
          fontSize: '0.85rem',
          color: 'var(--muted)',
          margin: '0 0 1rem',
          lineHeight: 1.5,
        }}
      >
        {msg}
      </p>
      <button
        onClick={() => app.keys.manage(provider)}
        style={{
          background: 'var(--accent)',
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

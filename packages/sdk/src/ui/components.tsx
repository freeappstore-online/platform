import {
  Component,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { FreeAppStore } from '../index.js';

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
      className="border-2 border-line rounded-full motion-safe:animate-spin"
      // Dynamic: Spinner size and color come from caller props.
      style={{ width: size, height: size, borderTopColor: color }}
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
  className?: string;
}

const badgeClasses = {
  default: 'bg-panel text-muted border-line',
  accent: 'bg-accent-soft text-accent border-accent',
  success: 'bg-success-soft text-success border-success',
  warning: 'bg-warning-soft text-warning border-warning',
  danger: 'bg-danger-soft text-danger border-danger',
};

export function Badge({ children, variant = 'default', style: extraStyle, className }: BadgeProps) {
  const palette = badgeClasses[variant];
  return (
    <span
      className={[
        'inline-flex',
        'items-center',
        'gap-1',
        'p-[0.15rem_0.5rem]',
        'rounded-full',
        'text-[0.75rem]',
        'font-semibold',
        'leading-[1.4]',
        'border',
        palette,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      // Dynamic: Caller-supplied appearance remains supported for compatibility; prefer className.
      style={{ ...extraStyle }}
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
  className?: string;
}

export function Card({
  children,
  onClick,
  padding = '1rem',
  style: extraStyle,
  className,
}: CardProps) {
  const interactive = !!onClick;
  const Tag = interactive ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={[
        'block',
        'w-full',
        'text-left',
        'rounded',
        'border border-line',
        'bg-panel',
        interactive ? 'cursor-pointer' : '',
        'font-[inherit]',
        'text-[inherit]',
        'text-inherit',
        'transition-colors duration-150',
        'focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      // Dynamic: Card padding and appearance come from caller props.
      style={{ padding: padding, ...extraStyle }}
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
  className?: string;
}

export function Tabs({ tabs, active, onChange, style: extraStyle, className }: TabsProps) {
  return (
    <div
      className={[
        'inline-flex',
        'gap-1',
        'p-1',
        'rounded-full',
        'border border-line',
        'bg-panel',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      // Dynamic: Caller-supplied appearance remains supported for compatibility; prefer className.
      style={{ ...extraStyle }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={[
            'p-[0.35rem_0.85rem]',
            'rounded-full',
            'border-0',
            'text-[0.8rem]',
            'font-semibold',
            'cursor-pointer',
            'font-[inherit]',
            'transition-all duration-150',
            active === tab.key ? 'bg-ink' : 'bg-transparent',
            active === tab.key ? 'text-panel' : 'text-muted',
          ]
            .filter(Boolean)
            .join(' ')}
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
  /** Shown as the dialog's heading and used as its accessible name. */
  title?: string;
  /** Accessible name when there is no visible `title`. */
  ariaLabel?: string;
  /** Esc closes the dialog (calls `onClose`). Default: true. */
  closeOnEscape?: boolean;
  maxWidth?: number;
}

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Focusable elements inside `root`, in tab order, skipping hidden ones. */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}

/** Open dialogs, innermost last: only the top one handles Tab and Esc. */
const openDialogs: HTMLElement[] = [];

/**
 * An accessible modal dialog (`role="dialog"`, `aria-modal`), labelled by its
 * title. On open, focus moves into it: to an element marked `data-autofocus`,
 * else the first focusable element in the content, else the close button,
 * else the dialog itself. Tab and Shift-Tab stay inside it, Esc closes it
 * (unless `closeOnEscape={false}`), and on close focus returns to the element
 * that had it before, usually the button that opened the dialog.
 */
export function Modal({
  open,
  onClose,
  children,
  title,
  ariaLabel,
  closeOnEscape = true,
  maxWidth = 480,
}: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Read through refs so an inline `onClose={() => …}` doesn't re-run the
  // open effect (and re-steal focus) on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Order by nesting, not by mount: React runs a nested dialog's effect
    // before its parent's, so a parent goes below any dialog it contains.
    const nested = openDialogs.findIndex((d) => dialog.contains(d));
    if (nested === -1) openDialogs.push(dialog);
    else openDialogs.splice(nested, 0, dialog);

    if (openDialogs[openDialogs.length - 1] === dialog) {
      const content = contentRef.current;
      const initial =
        dialog.querySelector<HTMLElement>('[data-autofocus]') ??
        (content ? focusableIn(content)[0] : undefined) ??
        focusableIn(dialog)[0] ??
        dialog;
      initial.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== dialog) return;
      if (e.key === 'Escape') {
        if (!closeOnEscapeRef.current) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableIn(dialog);
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (e.shiftKey && (active === first || !inside || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Focus that escapes some other way (a click on the backdrop, assistive
    // tech) is pulled back in.
    const onFocusIn = (e: FocusEvent) => {
      if (openDialogs[openDialogs.length - 1] !== dialog) return;
      if (e.target instanceof Node && !dialog.contains(e.target)) {
        (focusableIn(dialog)[0] ?? dialog).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      const index = openDialogs.lastIndexOf(dialog);
      if (index !== -1) openDialogs.splice(index, 1);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[999] bg-scrim backdrop-blur-[4px] flex items-center justify-center p-4 motion-safe:animate-sdk-fade-in"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="outline-none bg-popover border border-line rounded-lg w-full max-h-[85dvh] overflow-auto motion-safe:animate-sdk-slide-up"
        // Dynamic: Dialog maximum width comes from the caller prop.
        style={{ maxWidth: maxWidth }}
      >
        {title && (
          <div className="flex items-center justify-between p-[1rem_1.25rem] border-b border-line">
            <h2 id={titleId} className="m-0 text-[1rem] font-bold text-ink">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="bg-transparent border-0 cursor-pointer p-1 text-muted text-[1.25rem] leading-[1] font-[inherit]"
            >
              &times;
            </button>
          </div>
        )}
        <div ref={contentRef} className="p-5">
          {children}
        </div>
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
  /** Esc cancels the dialog. Default: true. */
  closeOnEscape?: boolean;
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  message,
  confirmLabel = 'Confirm',
  variant = 'default',
  closeOnEscape = true,
}: ConfirmDialogProps) {
  const isDanger = variant === 'danger';
  return (
    // Focus starts on Cancel (the first button), the safe choice for a destructive confirm.
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      maxWidth={400}
      closeOnEscape={closeOnEscape}
    >
      <p className="text-[0.9rem] text-muted m-[0_0_1.25rem]">{message}</p>
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="p-[0.5rem_1rem] rounded-sm border border-line bg-transparent text-ink text-[0.85rem] font-semibold cursor-pointer font-[inherit]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={[
            'p-[0.5rem_1rem]',
            'rounded-sm',
            'border-0',
            'text-[0.85rem]',
            'font-semibold',
            'cursor-pointer',
            'font-[inherit]',
            isDanger ? 'bg-danger' : 'bg-accent',
            'text-white',
          ]
            .filter(Boolean)
            .join(' ')}
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
    <div className="text-center p-[3rem_1.5rem]">
      {icon && <div className="mb-3 text-muted text-[2rem]">{icon}</div>}
      {title && <div className="text-[1rem] font-bold text-ink mb-[0.35rem]">{title}</div>}
      <p className="text-[0.85rem] text-muted m-[0_0_1rem] max-w-80 [margin-inline:auto]">
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
      {label && <div className="text-[0.75rem] font-semibold text-muted mb-[0.35rem]">{label}</div>}
      <div
        className="w-full bg-line overflow-hidden"
        // Dynamic: Track height and corner radius follow the caller height prop.
        style={{ height: height, borderRadius: height }}
      >
        <div
          className="h-full transition-[width] duration-300"
          // Dynamic: Progress width is calculated from value/max; radius and color come from props.
          style={{ width: `${pct}%`, borderRadius: height, background: color }}
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
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  style: extraStyle,
  className,
}: SearchInputProps) {
  return (
    <div
      className={['relative', className].filter(Boolean).join(' ')}
      // Dynamic: Caller-supplied appearance remains supported for compatibility; prefer className.
      style={{ ...extraStyle }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--muted)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="absolute left-3 top-[50%] [transform:translateY(-50%)] [pointer-events:none]"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className="w-full p-[0.5rem_0.75rem_0.5rem_2.25rem] rounded-full border border-line bg-panel text-ink text-[0.85rem] font-[inherit] outline-none"
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
      className={[
        'flex',
        'items-center',
        'gap-3',
        'w-full',
        'p-[0.65rem_0.75rem]',
        'bg-transparent',
        'border-0',
        'border-b border-line',
        'text-left',
        onClick ? 'cursor-pointer' : '',
        'font-[inherit]',
        'text-inherit',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon && <div className="shrink-0 text-muted">{icon}</div>}
      <div className="flex-1 min-w-0">
        <div className="text-[0.9rem] font-semibold text-ink overflow-hidden [text-overflow:ellipsis] whitespace-nowrap">
          {title}
        </div>
        {subtitle && (
          <div className="text-[0.75rem] text-muted overflow-hidden [text-overflow:ellipsis] whitespace-nowrap">
            {subtitle}
          </div>
        )}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
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
          <div className="p-8 text-center">
            <p className="text-danger font-bold mb-2">Something went wrong</p>
            <p className="text-muted text-[0.85rem]">{this.state.error.message}</p>
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
        className="fixed bottom-2 right-2 w-6 h-6 z-[9999] cursor-default opacity-[0]"
        aria-hidden="true"
      />
      {visible && (
        <div
          onClick={() => setVisible(false)}
          className="fixed bottom-2 right-2 z-[9999] bg-popover text-ink border border-line shadow-lg p-[0.5rem_0.75rem] rounded-[0.5rem] text-[0.7rem] font-mono leading-[1.6] max-w-70 cursor-pointer motion-safe:animate-sdk-fade-in"
        >
          {v && (
            <div>
              <span className="text-muted">version </span>
              {v}
            </div>
          )}
          {sha && (
            <div>
              <span className="text-muted">commit </span>
              {sha.slice(0, 7)}
            </div>
          )}
          {date && (
            <div>
              <span className="text-muted">built </span>
              {new Date(date).toLocaleString()}
            </div>
          )}
          {extra &&
            Object.entries(extra).map(([k, val]) => (
              <div key={k}>
                <span className="text-muted">{k.padEnd(8)}</span>
                {val}
              </div>
            ))}
          <div className="text-muted mt-1 text-[0.6rem]">tap to dismiss</div>
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
    <footer className="fixed left-0 right-0 bottom-0 z-[900] text-center bg-panel border-t border-line pt-2 pb-[calc(0.5rem_+_env(safe-area-inset-bottom,_0px))] backdrop-blur-[20px]">
      <a
        href="https://freeappstore.online"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[0.65rem] font-semibold tracking-[0.05em] uppercase text-muted no-underline"
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
    <div className="bg-panel border border-line rounded p-6 max-w-105 m-[2rem_auto] text-center">
      <div className="text-[1.5rem] mb-2">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="inline-block align-middle"
        >
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      </div>
      <div className="text-[1rem] font-bold text-ink mb-2">{name} API key required</div>
      <p className="text-[0.85rem] text-muted m-[0_0_1rem] leading-[1.5]">{msg}</p>
      <button
        onClick={() => app.keys.manage(provider)}
        className="bg-accent text-white border-0 p-[0.6rem_1.5rem] rounded text-[0.9rem] font-bold cursor-pointer font-[inherit]"
      >
        Configure {name} key
      </button>
    </div>
  );
}

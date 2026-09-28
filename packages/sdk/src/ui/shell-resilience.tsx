import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FreeAppStore } from '../index.js';

// Shell's resilience and feedback layer (#89): error boundary, toasts, offline
// banner, skip link, and scroll/focus on client-side route changes.

// Skip link, offline banner, toasts, error/loading fallbacks and PageHeader.
// Tokens only, injected once by Shell like the navbar's stylesheet.
export const SHELL_CSS = `.fas-skip-link:not(:focus){position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.fas-skip-link:focus{position:fixed;top:.5rem;left:.5rem;z-index:1200;padding:.7rem 1rem;border:2px solid var(--accent);border-radius:var(--radius-sm,10px);background:var(--panel);color:var(--ink);font-weight:600;text-decoration:none;outline:2px solid var(--accent);outline-offset:2px}
.fas-main:focus{outline:none}
.fas-offline{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.25rem .5rem .25rem 1rem;background:var(--panel);color:var(--ink);border-bottom:1px solid var(--line);border-left:3px solid var(--warning);font-size:.875rem}
.fas-toast-region{position:fixed;bottom:1.25rem;left:50%;z-index:1100;display:flex;flex-direction:column;align-items:center;gap:.5rem;max-width:calc(100vw - 2rem);transform:translateX(-50%);pointer-events:none}
.fas-toast{display:flex;align-items:center;gap:.75rem;padding:.25rem .25rem .25rem 1rem;background:var(--ink);color:var(--panel);border-left:3px solid var(--accent);border-radius:var(--radius,.75rem);box-shadow:0 8px 24px rgba(0,0,0,.3);font-size:.875rem;pointer-events:auto}
.fas-toast[data-variant="success"]{border-left-color:var(--success)}
.fas-toast[data-variant="error"]{border-left-color:var(--danger,var(--error))}
.fas-dismiss{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0;border:0;border-radius:var(--radius-sm,10px);background:transparent;color:inherit;font:inherit;font-size:1.1rem;line-height:1;cursor:pointer;opacity:.75}
.fas-dismiss:hover{opacity:1}
.fas-shell-loading{display:flex;flex:1;align-items:center;justify-content:center;padding:3rem 1rem}
.fas-shell-error{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;padding:3rem 1rem;text-align:center;color:var(--ink)}
.fas-shell-error h1{margin:0;font-size:1.25rem}
.fas-shell-error p{margin:0;max-width:32rem;color:var(--muted);font-size:.9rem}
.fas-shell-error__retry{min-height:44px;padding:0 1.25rem;border:0;border-radius:var(--radius-sm,10px);background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.fas-page-header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:.75rem;margin:0 0 1.25rem}
.fas-page-header__title{margin:0;color:var(--ink);font-size:1.5rem;font-weight:700;line-height:1.2}
.fas-page-header__title:focus{outline:none}
.fas-page-header__description{margin:.25rem 0 0;color:var(--muted);font-size:.9rem}
.fas-dismiss:focus-visible,.fas-shell-error__retry:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

// ── Error boundary ──────────────────────────────────────────────

export interface ShellErrorContext {
  error: Error;
  /** Clear the error and render the screen again. */
  reset: () => void;
}

interface BoundaryProps {
  app: FreeAppStore;
  renderError: ((ctx: ShellErrorContext) => ReactNode) | undefined;
  /** A change (the current route) clears a caught error, so navigating away recovers. */
  resetKey: string;
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
  resetKey: string;
}

/**
 * Catches a render error in the app's content so one broken screen shows a
 * fallback instead of a white screen, and records it through `app.log`: an
 * error React catches never reaches `window.onerror`, so the logger's automatic
 * capture would miss it.
 */
export class ShellErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState,
  ): Partial<BoundaryState> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.props.app.log._renderError(err.message, {
      stack: err.stack,
      componentStack: info.componentStack ?? undefined,
      path: typeof window === 'undefined' ? undefined : window.location.pathname,
    });
  }

  reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.renderError) return this.props.renderError({ error, reset: this.reset });
    return (
      <div role="alert" className="fas-shell-error">
        <h1>Something went wrong</h1>
        <p>
          This screen hit an error and could not be shown. It has been reported. Try again, or use
          the navigation to go elsewhere.
        </p>
        <button type="button" className="fas-shell-error__retry" onClick={this.reset}>
          Try again
        </button>
      </div>
    );
  }
}

// ── Toasts ──────────────────────────────────────────────────────

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastOptions {
  variant?: ToastVariant;
  /** Milliseconds before it dismisses itself; 0 keeps it until dismissed. Default 4000. */
  duration?: number;
}

export interface ToastApi {
  /** Show a message; returns its id. */
  show: (message: string, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

interface QueuedToast {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

/** At most this many messages at once; the oldest goes first. */
const MAX_TOASTS = 4;

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Raise a message from any screen inside Shell. Messages appear in the shell's
 * single polite live region.
 *
 * ```tsx
 * const toast = useToast()
 * toast.show('Saved', { variant: 'success' })
 * ```
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <Shell>');
  return api;
}

function ToastItem({ toast, onDismiss }: { toast: QueuedToast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);
  return (
    <div className="fas-toast" data-variant={toast.variant}>
      <span>{toast.message}</span>
      <button
        type="button"
        className="fas-dismiss"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/**
 * The shell's toast queue. The region is always rendered, so it's already in
 * the accessibility tree when a message arrives (a live region created together
 * with its first message is often not announced). Items have no live role.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<QueuedToast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback(
    (id: number) => setToasts((all) => all.filter((t) => t.id !== id)),
    [],
  );
  const show = useCallback((message: string, options: ToastOptions = {}) => {
    const id = nextId.current++;
    const toast: QueuedToast = {
      id,
      message,
      variant: options.variant ?? 'info',
      duration: options.duration ?? 4000,
    };
    setToasts((all) => [...all, toast].slice(-MAX_TOASTS));
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className="fas-toast-region">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ── Offline ─────────────────────────────────────────────────────

/** `navigator.onLine`, kept current by the browser's online/offline events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

/**
 * A banner under the topbar while the connection is down. Its polite live
 * region is always present, so the change is announced. Dismissible; clears
 * itself on reconnect, and a later drop shows it again.
 */
export function OfflineBanner() {
  const online = useOnline();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (online) setDismissed(false);
  }, [online]);
  return (
    <div role="status" aria-live="polite">
      {!online && !dismissed && (
        <div className="fas-offline">
          <span>You're offline. Changes can't be saved until the connection is back.</span>
          <button
            type="button"
            className="fas-dismiss"
            aria-label="Dismiss offline notice"
            onClick={() => setDismissed(true)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// ── Skip link ───────────────────────────────────────────────────

/** The first focusable element: hidden until focused, moves focus to the shell's `<main id="main">`. */
export function SkipLink({ mainRef }: { mainRef: RefObject<HTMLElement | null> }) {
  return (
    // biome-ignore lint/a11y/useValidAnchor: a real link to #main (works without JS); the click handler only avoids a hash change.
    <a
      href="#main"
      className="fas-skip-link"
      onClick={(e) => {
        // Focus directly rather than following the fragment: a hash change is a
        // history navigation, which a router would see as a route change.
        e.preventDefault();
        mainRef.current?.focus();
      }}
    >
      Skip to content
    </a>
  );
}

// ── Route changes: scroll and focus ─────────────────────────────

/**
 * Scroll and focus on client-side route changes. Forward navigation lands at the
 * top; back/forward returns to where that route was left. After either, focus
 * moves to the new screen's PageHeader `<h1>`, else to `<main>`.
 *
 * Only for client-side navigation (`enabled` = the app passed `onNavigate`):
 * with ordinary links every navigation is a page load, and the browser already
 * restores scroll and resets focus.
 *
 * Returns the function to call just before a forward navigation.
 */
export function useRouteChangeEffects(
  path: string,
  mainRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): () => void {
  const positions = useRef(new Map<string, number>());
  const lastPath = useRef(path);
  const kind = useRef<'push' | 'pop'>('push');

  useEffect(() => {
    if (!enabled) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    // Runs before the re-render the same popstate causes, while the page still
    // shows the route being left.
    const onPop = () => {
      positions.current.set(lastPath.current, window.scrollY);
      kind.current = 'pop';
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.history.scrollRestoration = previous;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || path === lastPath.current) return;
    lastPath.current = path;
    const back = kind.current === 'pop';
    kind.current = 'push';
    // A frame later, so a router that renders the new screen in its own update
    // has committed it before we scroll to it and look for its heading.
    const frame = requestAnimationFrame(() => {
      window.scrollTo(0, back ? (positions.current.get(path) ?? 0) : 0);
      const main = mainRef.current;
      const target = main?.querySelector<HTMLElement>('[data-fas-page-heading]') ?? main;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [path, enabled, mainRef]);

  return useCallback(() => {
    positions.current.set(lastPath.current, window.scrollY);
    kind.current = 'push';
  }, []);
}

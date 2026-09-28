import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useInsertionEffect,
  useRef,
  useState,
} from 'react';

/** One screen in the app's main navigation. */
export interface NavItem {
  label: string;
  /** Same-origin path, e.g. `/` or `/notes`. */
  href: string;
  /** Optional icon, rendered before the label (mark it `aria-hidden`). */
  icon?: ReactNode;
  /**
   * Tab title while this item's route is current. Shell applies it; a screen's
   * own `useDocumentTitle` overrides it.
   */
  title?: string;
}

export interface NavBarProps {
  items: NavItem[];
  /**
   * The route to mark as current. Defaults to `location.pathname`, kept in step
   * with back/forward (`popstate`). Pass your router's location when you use one.
   */
  currentPath?: string;
  /**
   * Client-side navigation: called instead of a full page load on a plain left
   * click. Without it the items are ordinary links.
   */
  onNavigate?: (href: string) => void;
}

/** The browser's current path, following back/forward. `initial` wins when given. */
export function useCurrentPath(initial?: string): [string, (path: string) => void] {
  const [path, setPath] = useState(
    () => initial ?? (typeof window === 'undefined' ? '/' : window.location.pathname),
  );
  useEffect(() => {
    if (initial !== undefined) {
      setPath(initial);
      return;
    }
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [initial]);
  return [path, setPath];
}

/** The item to mark current: an exact match, else the longest prefix (`/notes` for `/notes/42`). */
export function activeHref(items: NavItem[], path: string): string | null {
  let best: string | null = null;
  for (const { href } of items) {
    const matches =
      href === path || (href !== '/' && path.startsWith(`${href.replace(/\/+$/, '')}/`));
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

// Hover, focus and the small-screen collapse need real CSS, so it's injected
// once like the SDK's keyframes. Tokens only, so it follows light/dark theme.
export const NAVBAR_CSS = `.fas-nav{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0;margin:0 .5rem}
.fas-nav__toggle{display:none;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0;border:1px solid var(--line);border-radius:var(--radius-sm,10px);background:transparent;color:var(--ink);font:inherit;cursor:pointer}
.fas-nav__list{display:flex;align-items:center;gap:.25rem;margin:0;padding:0;list-style:none;overflow-x:auto}
.fas-nav__link{display:inline-flex;align-items:center;gap:.4rem;min-height:44px;padding:0 .75rem;border-radius:var(--radius-sm,10px);color:var(--muted);font-size:.9rem;font-weight:600;text-decoration:none;white-space:nowrap}
.fas-nav__link:hover{color:var(--ink);background:var(--line)}
.fas-nav__link[aria-current="page"]{color:var(--accent);background:var(--accent-soft,var(--line))}
.fas-nav__toggle:focus-visible,.fas-nav__link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:639px){.fas-nav{flex:0 0 auto;margin:0}.fas-nav__toggle{display:inline-flex}.fas-nav__list{display:none;position:absolute;top:calc(100% + .5rem);left:0;z-index:60;flex-direction:column;align-items:stretch;min-width:12rem;padding:.5rem;overflow:visible;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius,12px);box-shadow:0 8px 24px rgba(0,0,0,.12)}.fas-nav[data-open="true"] .fas-nav__list{display:flex}}
`;

function useNavbarStyles(): void {
  useInsertionEffect(() => {
    if (document.getElementById('fas-nav-css')) return;
    const style = document.createElement('style');
    style.id = 'fas-nav-css';
    style.textContent = NAVBAR_CSS;
    document.head.appendChild(style);
  }, []);
}

/**
 * NavBar — the app's main navigation. Shell renders it in its topbar from the
 * `nav` prop; it also works on its own in a custom layout.
 *
 * `<nav aria-label="Main">` landmark, `aria-current="page"` on the current item,
 * 44px targets, visible focus, and below 640px a menu button (`aria-expanded` /
 * `aria-controls`; Escape or a click outside closes it, Escape returns focus).
 * Renders nothing when there are no items.
 */
export function NavBar({ items, currentPath, onNavigate }: NavBarProps) {
  useNavbarStyles();
  const [path, setPath] = useCurrentPath(currentPath);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (returnFocus: boolean) => {
      setOpen(false);
      if (returnFocus) toggleRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onPointer = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  if (items.length === 0) return null;
  const current = activeHref(items, path);

  const follow = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    setOpen(false);
    if (
      !onNavigate ||
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    e.preventDefault();
    onNavigate(href);
    if (currentPath === undefined) setPath(href);
  };

  return (
    <nav ref={navRef} aria-label="Main" className="fas-nav" data-open={open ? 'true' : 'false'}>
      <button
        ref={toggleRef}
        type="button"
        className="fas-nav__toggle"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="Menu"
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d={open ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} />
        </svg>
      </button>
      <ul id={listId} className="fas-nav__list">
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              aria-current={item.href === current ? 'page' : undefined}
              className="fas-nav__link"
              onClick={(e) => follow(e, item.href)}
            >
              {item.icon}
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

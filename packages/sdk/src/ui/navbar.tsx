import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';

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
    <nav
      ref={navRef}
      aria-label="Main"
      className="fas-nav relative mx-0 flex min-w-0 flex-none items-center sm:mx-2 sm:flex-auto"
      data-open={open ? 'true' : 'false'}
    >
      <button
        ref={toggleRef}
        type="button"
        className="fas-nav__toggle inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm border border-line bg-transparent p-0 text-ink cursor-pointer sm:hidden focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
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
      <ul
        id={listId}
        className={`fas-nav__list fixed right-0 top-14 z-60 m-0 h-[calc(100dvh-3.5rem)] w-72 max-w-[calc(100vw-1rem)] flex-col items-stretch gap-1 overflow-y-auto border-l border-line bg-popover p-3 text-ink shadow-lg motion-safe:transition-transform motion-safe:duration-200 sm:static sm:h-auto sm:w-auto sm:max-w-none sm:translate-x-0 sm:flex-row sm:items-center sm:overflow-x-auto sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none ${open ? 'flex translate-x-0 motion-safe:animate-sdk-drawer sm:animate-none' : 'hidden translate-x-full sm:flex'}`}
      >
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              aria-current={item.href === current ? 'page' : undefined}
              className="fas-nav__link inline-flex min-h-11 items-center gap-[0.4rem] whitespace-nowrap rounded-sm px-3 text-[0.9rem] font-semibold text-muted no-underline hover:bg-line hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
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

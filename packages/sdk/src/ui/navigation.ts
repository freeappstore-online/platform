import { type MouseEvent, useCallback, useEffect, useState } from 'react';

/** Resolve before invoking a router: the callback may change the URL used as the base. */
export function routeUrl(href: string): URL | null {
  try {
    return new URL(
      href,
      typeof window === 'undefined' ? 'https://fas.invalid/' : window.location.href,
    );
  } catch {
    return null;
  }
}

export function routeHref(url: URL): string {
  return url.origin === routeUrl('/')?.origin ? url.pathname + url.search + url.hash : url.href;
}

export function browserHref(): string {
  return typeof window === 'undefined' ? '/' : routeHref(new URL(window.location.href));
}

export function isLocalRoute(url: URL | null): url is URL {
  return !!url && /^https?:$/.test(url.protocol) && url.origin === routeUrl('/')?.origin;
}

export function routePath(href: string): string {
  return routeUrl(href)?.pathname.replace(/\/+$/, '') || '/';
}

/** Preserve native navigation for modifiers, new tabs, downloads and external links. */
export function canFollowLink(event: MouseEvent<HTMLAnchorElement>, href: string): boolean {
  const link = event.currentTarget;
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!link.target || link.target === '_self') &&
    !link.hasAttribute('download') &&
    isLocalRoute(routeUrl(href))
  );
}

/** Includes query/hash so Back within a pathname still updates the shell. */
export function useCurrentLocation(controlled?: string): [string, (href: string) => void] {
  const browser = browserHref();
  const [location, setLocation] = useState(() => ({ browser, href: controlled ?? browser }));
  const update = useCallback((href: string) => {
    setLocation({ browser: browserHref(), href });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sync after a router changes browser history without emitting an event.
  useEffect(() => {
    if (controlled !== undefined) {
      update(controlled);
      return;
    }
    // App routers may re-render their layout after pushState, without popstate.
    const sync = () => update(browserHref());
    sync();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [controlled, browser, update]);
  // A browser change wins immediately, before effects. In particular, never
  // render an old OAuth callback fragment after auth.init has consumed it.
  return [controlled ?? (location.browser === browser ? location.href : browser), update];
}

/** Only allow an in-app return destination, never an off-site URL or a profile loop. */
export function profileReturnHref(location: string): string {
  const candidate = routeUrl(location)?.searchParams.get('returnTo');
  if (!candidate?.startsWith('/') || candidate.startsWith('//')) return '/';
  const url = routeUrl(candidate);
  return isLocalRoute(url) && routePath(url.pathname) !== '/profile' ? routeHref(url) : '/';
}

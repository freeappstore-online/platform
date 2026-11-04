import type { MouseEvent } from 'react';
export function routeUrl(href: string): URL {
  return new URL(
    href,
    typeof window === 'undefined' ? 'https://fas.invalid/' : window.location.href,
  );
}
export function routeHref(url: URL): string {
  return url.origin === routeUrl('/').origin ? url.pathname + url.search + url.hash : url.href;
}
/** Preserve native behavior for external destinations, modified clicks and special links. */
export function canFollowLink(event: MouseEvent<HTMLAnchorElement>, href: string): boolean {
  const link = event.currentTarget;
  const url = routeUrl(href);
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !link.hasAttribute('download') &&
    (!link.target || link.target === '_self') &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.origin === routeUrl('/').origin
  );
}

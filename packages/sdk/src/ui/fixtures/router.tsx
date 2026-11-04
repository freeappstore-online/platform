import { useRef } from 'react';
import { isLocalRoute, routeHref, routeUrl, useCurrentLocation } from '../navigation.js';
import { useRouteChangeEffects } from '../shell-resilience.js';

/** Client-side history helper shared by the custom-frame fixtures. */
export function useInAppNavigate() {
  const mainRef = useRef<HTMLElement>(null);
  const [location, setLocation] = useCurrentLocation();
  const beforeNavigate = useRouteChangeEffects(location, mainRef, true);
  const navigate = (href: string) => {
    const destination = routeUrl(href);
    if (!destination || !isLocalRoute(destination)) {
      window.location.assign(href);
      return;
    }
    beforeNavigate();
    const next = routeHref(destination);
    window.history.pushState(null, '', next);
    setLocation(next);
  };
  return { location, mainRef, navigate };
}

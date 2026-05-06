/**
 * Quality reporter for FreeAppStore / FreeGameStore apps.
 *
 * When an app is loaded inside an iframe (i.e. by the platform Quality
 * Dashboard at https://freeappstore.online/quality), this reporter posts
 * viewport / overflow / clipping metrics back to the parent so the
 * dashboard can audit layout fit at every reference viewport without
 * needing same-origin DOM access.
 *
 * In production (top-level navigation) the reporter is a no-op — there's
 * no parent to receive messages, so we don't waste CPU.
 *
 * Privacy note: posts contain ONLY viewport / DOM-shape numbers. No URLs
 * (parent already knows), no localStorage, no user content, no identifiers.
 * Apps remain fully privacy-first; this is structural metadata for QA only.
 *
 * Cooperation contract: the platform's audit treats apps that import this
 * reporter (and respond to dashboard probes) as audit-cooperative. Apps
 * that ship without it can still be listed but won't get a Quality Index
 * badge — opt-out is allowed but visible.
 */

export interface ViewportReport {
  type: 'fas:quality';
  schema: 1;
  /** ms since epoch when the snapshot was taken. */
  capturedAt: number;
  /** Top-level subdomain (e.g. "tetris" from tetris.freegamestore.online). */
  appId: string;
  /** Viewport size as the iframe sees it (parent sets this). */
  viewport: { width: number; height: number };
  /** Document scroll vs viewport — if scrollWidth > clientWidth, the page scrolls horizontally. */
  document: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    scrollsX: boolean;
    scrollsY: boolean;
  };
  /** Inner-clipping: any element with overflow:hidden|clip whose content overflows its box. */
  clipping: ClippingHit[];
  /** Color scheme the app currently believes it's in (light | dark | unknown). */
  colorScheme: 'light' | 'dark' | 'unknown';
  /** Whether prefers-reduced-motion is set. */
  reducedMotion: boolean;
  /** SDK / reporter version that produced this. Lets the dashboard
   *  detect / migrate when the schema changes. */
  reporterVersion: string;
}

export interface ClippingHit {
  /** CSS-ish selector best-effort: tag + first class or id. */
  selector: string;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  clipsX: boolean;
  clipsY: boolean;
}

const REPORTER_VERSION = '0.1.0';
const TOLERANCE_PX = 1;
const MAX_CLIPPING_HITS = 20;

/**
 * Whether the page should report. Returns false when:
 * - There's no `window.parent` (Node / SSR)
 * - The page is loaded top-level (no parent to talk to)
 * - The user has set window.__FAS_QUALITY_DISABLE = true (for embeds where
 *   the host is hostile — e.g. an iframe embed on a third-party site that
 *   we don't want to leak metrics to).
 */
function shouldReport(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.parent === window) return false;
  if ((window as unknown as { __FAS_QUALITY_DISABLE?: boolean }).__FAS_QUALITY_DISABLE) return false;
  return true;
}

/**
 * Synchronously snapshot the current layout state. Cheap (single DOM walk)
 * but called frequently during resize, so we cap clipping hits.
 */
export function snapshot(): ViewportReport {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const w = typeof window !== 'undefined' ? window : (undefined as unknown as Window);

  const fallback = (): ViewportReport => ({
    type: 'fas:quality',
    schema: 1,
    capturedAt: Date.now(),
    appId: '',
    viewport: { width: 0, height: 0 },
    document: {
      scrollWidth: 0,
      scrollHeight: 0,
      clientWidth: 0,
      clientHeight: 0,
      scrollsX: false,
      scrollsY: false,
    },
    clipping: [],
    colorScheme: 'unknown',
    reducedMotion: false,
    reporterVersion: REPORTER_VERSION,
  });

  if (!root) return fallback();

  const clipping: ClippingHit[] = [];
  // Walk all elements once; flag those with overflow:hidden|clip whose
  // content is larger than their box. This catches the common case where
  // a fixed-pixel container clips its child content but the document
  // itself doesn't scroll — invisible clipping that breaks UX without
  // tripping a naive scrollWidth check.
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length && clipping.length < MAX_CLIPPING_HITS; i++) {
    const el = all[i] as HTMLElement;
    const cs = getComputedStyle(el);
    const ovx = cs.overflowX;
    const ovy = cs.overflowY;
    const xClipped = (ovx === 'hidden' || ovx === 'clip') && el.scrollWidth > el.clientWidth + TOLERANCE_PX;
    const yClipped = (ovy === 'hidden' || ovy === 'clip') && el.scrollHeight > el.clientHeight + TOLERANCE_PX;
    if (!xClipped && !yClipped) continue;
    const idPart = el.id ? `#${el.id}` : '';
    const classPart = el.className && typeof el.className === 'string'
      ? `.${el.className.split(/\s+/).filter(Boolean)[0] ?? ''}`
      : '';
    clipping.push({
      selector: `${el.tagName.toLowerCase()}${idPart}${classPart}`,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      clipsX: xClipped,
      clipsY: yClipped,
    });
  }

  const colorScheme: 'light' | 'dark' | 'unknown' =
    typeof matchMedia === 'function'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : 'unknown';
  const reducedMotion =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false;

  // App ID is the leftmost subdomain on a *.freeappstore.online or
  // *.freegamestore.online host; bare domains (local dev, custom domains)
  // get the empty string and the dashboard falls back to the iframe URL.
  const host = w.location.hostname;
  const m = /^([^.]+)\.(?:freeappstore|freegamestore)\.online$/.exec(host);
  const appId = m?.[1] ?? '';

  return {
    type: 'fas:quality',
    schema: 1,
    capturedAt: Date.now(),
    appId,
    viewport: { width: w.innerWidth, height: w.innerHeight },
    document: {
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
      scrollsX: root.scrollWidth > root.clientWidth + TOLERANCE_PX,
      scrollsY: root.scrollHeight > root.clientHeight + TOLERANCE_PX,
    },
    clipping,
    colorScheme,
    reducedMotion,
    reporterVersion: REPORTER_VERSION,
  };
}

interface ReporterHandle {
  /** Stop reporting and detach all listeners. */
  stop(): void;
  /** Force a snapshot + post immediately (e.g. after a layout change). */
  reportNow(): void;
}

/**
 * Start the reporter. Idempotent — calling twice returns the existing
 * handle. Designed for one-line use: `initQualityReporter()` from your
 * app's main.tsx / entry. The reporter is a no-op when not iframed,
 * so leaving it on in production has zero cost.
 *
 * Channels:
 * - posts to `window.parent` with `type: 'fas:quality'`
 * - listens on `window` for `type: 'fas:quality:request'` so the parent
 *   can poll on demand (e.g. after resizing the iframe)
 */
export function initQualityReporter(): ReporterHandle {
  // Idempotency guard: parent dashboards can probe + the SDK can also
  // call this; we only want one reporter per page.
  const w = typeof window !== 'undefined' ? window : null;
  if (!w) return { stop: () => undefined, reportNow: () => undefined };
  const existing = (w as unknown as { __FAS_QUALITY_REPORTER__?: ReporterHandle }).__FAS_QUALITY_REPORTER__;
  if (existing) return existing;

  if (!shouldReport()) {
    // No-op handle — production page with no parent. Still install one
    // marker so a later call doesn't try to install again.
    const noop: ReporterHandle = { stop: () => undefined, reportNow: () => undefined };
    (w as unknown as { __FAS_QUALITY_REPORTER__?: ReporterHandle }).__FAS_QUALITY_REPORTER__ = noop;
    return noop;
  }

  const post = () => {
    try {
      w.parent.postMessage(snapshot(), '*');
    } catch {
      // Parent may have closed or set restrictive CSP; nothing to do.
    }
  };

  // Fire on initial layout, after fonts settle, and after any subsequent
  // resize. The 250ms delay matches what fas screencheck waits for fonts.
  const initialPost = () => {
    post();
    setTimeout(post, 250);
    setTimeout(post, 1500); // catch late layout (web fonts, lazy images)
  };

  const onResize = () => post();
  const onMessage = (e: MessageEvent) => {
    const data = e.data as { type?: string } | null;
    if (data && data.type === 'fas:quality:request') post();
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initialPost();
  } else {
    document.addEventListener('DOMContentLoaded', initialPost, { once: true });
  }
  w.addEventListener('resize', onResize);
  w.addEventListener('message', onMessage);

  const handle: ReporterHandle = {
    stop: () => {
      w.removeEventListener('resize', onResize);
      w.removeEventListener('message', onMessage);
      delete (w as unknown as { __FAS_QUALITY_REPORTER__?: ReporterHandle }).__FAS_QUALITY_REPORTER__;
    },
    reportNow: post,
  };
  (w as unknown as { __FAS_QUALITY_REPORTER__?: ReporterHandle }).__FAS_QUALITY_REPORTER__ = handle;
  return handle;
}

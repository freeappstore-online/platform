import type { FileSource } from '../lib/file-source.js';
import { stripCommentsForExt } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

// A tracker is only "installed" where its SDK can actually be loaded:
// an npm dependency in package.json, an import/require/`<script src>`
// specifier, a tracker hostname, or an SDK call site. Bare tracker names
// in arbitrary text never count — "plausible" is an English word (it sat
// in public-domain book text under web/public/catalog/*.json), "segment"
// and "amplitude" are geometry / physics terms.
type TrackerSpec = {
  name: string;
  /** Tested against npm dependency names and import / require / src specifiers. */
  packages?: RegExp;
  /** Tested against comment-stripped code and HTML: hostnames, call sites. */
  patterns: RegExp[];
};

// Matches `name` as a whole package path segment: `posthog-js`,
// `posthog-js/react`, `posthog-js@1.2.3`, `https://esm.sh/posthog-js`.
function pkg(...names: string[]): RegExp {
  const alts = names.map(escapeForRegExp).join('|');
  return new RegExp(`(?:^|/)(?:${alts})(?:$|[/@])`, 'i');
}

const TRACKERS: TrackerSpec[] = [
  {
    name: 'google-analytics',
    packages: pkg(
      'google-analytics',
      'react-ga',
      'react-ga4',
      'ga-gtag',
      'universal-analytics',
      'vue-gtag',
    ),
    patterns: [/google-analytics\.com/i, /googletagmanager\.com/i],
  },
  // `gtag` as a bare token would catch nothing real, but the GA install snippet
  // always calls it like `gtag('config', ...)` or `gtag('event', ...)` or
  // declares `window.gtag = ...`. Match those, not the bare identifier.
  { name: 'gtag', patterns: [/\bgtag\s*\(\s*['"]/i, /window\.gtag\b/i, /gtag\.js/i] },
  // Amplitude SDK shows up as @amplitude/* scoped package, amplitude.com host,
  // or amplitude.init/track/getInstance call. Bare `amplitude` (the physics
  // term) is fine.
  {
    name: 'amplitude',
    packages: pkg('@amplitude', 'amplitude-js'),
    patterns: [
      /amplitude\.com/i,
      /\bamplitude\s*\.\s*(?:init|track|getInstance|setUserId|logEvent)\b/i,
    ],
  },
  {
    name: 'mixpanel',
    packages: pkg('mixpanel-browser', 'mixpanel'),
    patterns: [
      /mixpanel\.com/i,
      /cdn\.mxpnl\.com/i,
      /\bmixpanel\s*\.\s*(?:init|track|identify|people|register)\b/i,
    ],
  },
  // Segment SDK: scoped package, hostname, or window.analytics.track/identify.
  // Bare `segment` (geometry term — ball-line-segment, drop-target row segment)
  // is fine.
  {
    name: 'segment',
    packages: pkg('@segment', 'analytics-node'),
    patterns: [
      /segment\.io/i,
      /segment\.com\/analytics/i,
      /cdn\.segment\.com/i,
      /window\.analytics\s*\.\s*(?:track|identify|page|group)\b/i,
      /\bAnalyticsBrowser\.load\b/i,
    ],
  },
  {
    name: 'hotjar',
    packages: pkg('@hotjar', 'react-hotjar', 'vue-hotjar'),
    patterns: [/hotjar\.com/i, /\b_hjSettings\b/, /\bhj\s*\(\s*['"]/],
  },
  {
    name: 'plausible',
    packages: pkg('plausible-tracker', '@plausible'),
    patterns: [
      /plausible\.io/i,
      // self-hosted copy of the tracker script: plausible.js, plausible.outbound-links.js
      /\bplausible(?:\.[a-z-]+)*\.js\b/i,
      /window\.plausible\b/i,
      /\bplausible\s*\(\s*['"]/i,
    ],
  },
  {
    name: 'posthog',
    packages: pkg('posthog-js', 'posthog-node', '@posthog'),
    patterns: [/posthog\.com/i, /\bposthog\s*\.\s*(?:init|capture|identify)\b/i],
  },
];

// package.json dependencies install an SDK; every other .json file is data.
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.htm']);

// Where an SDK is loaded from in code / HTML: `from 'x'`, `import('x')`,
// `require('x')`, `<script src="x">`, `el.src = 'x'`.
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bsrc\s*=\s*)['"]([^'"]+)['"]/g;

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Per-game compliance tests legitimately mention these tracker names as
// the banned list they assert NOT to find. Treating those as positives
// is the classic "check finds its own assertion" false positive.
function isSelfReferenceTestFile(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)\//.test(path) && /compliance\.test\.[jt]sx?$/.test(path);
}

function isPackageJson(path: string): boolean {
  return path === 'package.json' || path.endsWith('/package.json');
}

function dependencyNames(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const manifest = parsed as Record<string, unknown>;
  return DEP_FIELDS.flatMap((field) => {
    const deps = manifest[field];
    return deps && typeof deps === 'object' ? Object.keys(deps) : [];
  });
}

function installsPackage(t: TrackerSpec, names: string[]): boolean {
  const re = t.packages;
  return re !== undefined && names.some((n) => re.test(n));
}

/** Tracker names whose SDK is installed by `content` (code or HTML, comments stripped). */
export function matchTrackersInCode(content: string): string[] {
  const specifiers = [...content.matchAll(SPECIFIER_RE)].map((m) => m[1] ?? '');
  return TRACKERS.filter(
    (t) => t.patterns.some((re) => re.test(content)) || installsPackage(t, specifiers),
  ).map((t) => t.name);
}

/** Tracker names whose SDK package is a dependency of this package.json. */
export function matchTrackersInPackageJson(raw: string): string[] {
  const deps = dependencyNames(raw);
  return TRACKERS.filter((t) => installsPackage(t, deps)).map((t) => t.name);
}

export async function checkNoTracking(source: FileSource): Promise<CheckResult> {
  const hits: { file: string; matches: string[] }[] = [];

  for await (const path of source.list()) {
    const ext = extOf(path);
    let matches: string[];
    if (isPackageJson(path)) {
      const raw = await source.read(path);
      if (!raw) continue;
      matches = matchTrackersInPackageJson(raw);
    } else if (CODE_EXTS.has(ext) && !isSelfReferenceTestFile(path)) {
      const raw = await source.read(path);
      if (!raw) continue;
      // Strip comments only — NOT string literals. Real tracker loads live
      // inside strings (`import from "@amplitude/..."`,
      // `<script src="https://www.google-analytics.com/...">`), so erasing
      // string contents would erase the very evidence we need.
      matches = matchTrackersInCode(stripCommentsForExt(raw, ext));
    } else {
      continue;
    }
    if (matches.length > 0) {
      hits.push({ file: path, matches });
    }
  }

  if (hits.length === 0) {
    return {
      name: 'Analytics routed through platform loader',
      status: 'pass',
      detail: `no direct tracker SDKs found; analytics, if any, must flow through the platform loader (api.freeappstore.online/v1/analytics.js?app=<id>)`,
    };
  }

  return {
    name: 'Analytics routed through platform loader',
    status: 'fail',
    detail: `${hits.length} file(s) install trackers directly: ${hits
      .slice(0, 3)
      .map((h) => `${h.file} (${h.matches.join(', ')})`)
      .join('; ')}${hits.length > 3 ? '…' : ''}`,
    suggestions: [
      'Remove the direct SDK and reference the platform loader instead: <script src="https://api.freeappstore.online/v1/analytics.js?app=<id>" defer></script>.',
      'Configure providers (GA4, Plausible, custom <head>) via PUT /v1/apps/<id>/analytics — the loader emits the right tags so policy can evolve without redeploying every app.',
    ],
  };
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

import type { FileSource } from '../lib/file-source.js';
import { stripCommentsForExt } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

// FreeAppStore apps take no payments (owner decision, #289): free forever,
// monetization is a ProAppStore feature. The host also sends payment=(), so
// the Payment Request API can't run, but checkout SDKs, payment-provider APIs
// and hosted checkout links work without it. This check catches them.
//
// Out of scope by decision: a link to the creator's external donation or
// sponsor page (Ko-fi, GitHub Sponsors) isn't the app collecting a payment.
type PaymentSpec = { name: string; patterns: RegExp[] };

const PAYMENTS: PaymentSpec[] = [
  {
    name: 'Payment Request API',
    patterns: [/\bnew\s+PaymentRequest\s*\(/, /\bwindow\.PaymentRequest\b/, /\.paymentManager\b/],
  },
  { name: 'Apple Pay', patterns: [/\bApplePaySession\b/] },
  { name: 'Google Pay', patterns: [/pay\.google\.com\/gp\/p\/js/i, /@google-pay\//i] },
  {
    name: 'Stripe',
    patterns: [
      /@stripe\//i,
      /js\.stripe\.com/i,
      /(?:api|checkout|buy)\.stripe\.com/i,
      /\bloadStripe\s*\(/,
      /\bStripe\s*\(\s*['"`]pk_/,
      /"stripe"\s*:\s*"/,
    ],
  },
  {
    name: 'PayPal',
    patterns: [/paypal\.com\/sdk\/js/i, /@paypal\//i, /paypal\.com\/cgi-bin\/webscr/i],
  },
  { name: 'Paddle', patterns: [/cdn\.paddle\.com/i, /@paddle\//i] },
  { name: 'Lemon Squeezy', patterns: [/lemonsqueezy\.com/i, /@lemonsqueezy\//i] },
  { name: 'Gumroad', patterns: [/gumroad\.com\/(?:js|l)\//i] },
];

// Web app manifest members that register the app as a payment handler.
// `serviceworker` is only used by Chrome's just-in-time payment handler install.
const MANIFEST_PAYMENT_KEY = /^(?:payment\w*|serviceworker)$/i;
const INLINE_MANIFEST_PAYMENT_KEY = /\b(?:payment\w*|serviceworker)\s*:/;

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html', '.json', '.webmanifest']);

// Tests and e2e specs may name the APIs they assert are absent.
function isTestFile(path: string): boolean {
  return (
    /(?:^|\/)(?:test|tests|__tests__|e2e)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

export async function checkNoPayments(source: FileSource): Promise<CheckResult> {
  const hits: { file: string; matches: string[] }[] = [];

  for await (const path of source.list()) {
    const ext = extOf(path);
    if (!SCAN_EXTS.has(ext) || isTestFile(path)) continue;
    const raw = await source.read(path);
    if (!raw) continue;
    const content = stripCommentsForExt(raw, ext);
    const matches = PAYMENTS.filter((p) => p.patterns.some((re) => re.test(content))).map(
      (p) => p.name,
    );
    if (path.endsWith('manifest.json') || path.endsWith('.webmanifest')) {
      const keys = manifestKeys(raw);
      const bad = keys.filter((k) => MANIFEST_PAYMENT_KEY.test(k));
      if (bad.length) matches.push(`manifest payment member (${bad.join(', ')})`);
    }
    if (/(?:^|\/)vite\.config\.[cm]?[jt]s$/.test(path) && /\bVitePWA\s*\(/.test(content)) {
      if (INLINE_MANIFEST_PAYMENT_KEY.test(content)) matches.push('manifest payment member');
    }
    if (matches.length > 0) hits.push({ file: path, matches });
  }

  if (hits.length === 0) {
    return {
      name: 'No payments (free tier)',
      status: 'pass',
      detail: 'no payment APIs, checkout SDKs or payment manifest members found',
    };
  }

  return {
    name: 'No payments (free tier)',
    status: 'fail',
    detail: `${hits.length} file(s) take or register payments: ${hits
      .slice(0, 3)
      .map((h) => `${h.file} (${h.matches.join(', ')})`)
      .join('; ')}${hits.length > 3 ? '…' : ''}`,
    suggestions: [
      'FreeAppStore apps are free forever and take no payments: remove the payment API, checkout SDK or payment link.',
      'To charge for an app, publish it on ProAppStore (https://proappstore.online), which handles subscriptions and creator payouts.',
    ],
  };
}

function manifestKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed)
      : [];
  } catch {
    return [];
  }
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

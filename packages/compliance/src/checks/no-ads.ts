import type { FileSource } from '../lib/file-source.js';
import { stripCommentsForExt } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

// FreeAppStore apps show no ads (platform rule, stated on the storefront and
// in the Terms). The host CSP allows any https: script, so nothing at the edge
// stops an ad tag from loading; this check catches ad networks in the source.
//
// Every pattern is an ad-serving hostname, an ad SDK global used the way the
// SDK is called, or an ad SDK package name. Bare words are never enough:
// "ads", "adBreak", "banner", "sponsor", `onDoubleClick`, a `googletag`
// substring of googletagmanager.com (that one is the tracking check's job) and
// ordinary media.net-looking text all pass. Ambiguous globals (`adBreak`,
// `googletag`, `apstag`, `pbjs`) only match with the SDK's call shape.
//
// Out of scope by decision: a creator's own house promotion or a link to their
// other apps isn't an ad network, so the check doesn't look for it.
export type AdNetworkSpec = { name: string; patterns: RegExp[] };

// An ad SDK package referenced as a package: imported, required, or listed as
// a package.json dependency. A plain string that happens to hold the name
// (a keyword list, a label) doesn't count. `name` is a regex source.
function pkg(name: string): RegExp {
  const quoted = `['"](?:${name})(?:\\/[\\w./-]*)?['"]`;
  return new RegExp(
    `(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(?\\s*)${quoted}|${quoted}\\s*:\\s*['"](?:[~^<>=]*\\s*\\d|workspace:|npm:|latest)`,
  );
}

export const AD_NETWORKS: AdNetworkSpec[] = [
  {
    name: 'Google AdSense',
    patterns: [
      /pagead2\.googlesyndication\.com/i,
      /\btpc\.googlesyndication\.com/i,
      /\badservice\.google\.[a-z.]+\//i,
      /\badsbygoogle\b/,
      /\bdata-ad-client\s*=\s*['"]ca-pub-/i,
      /\bca-pub-\d{10,}\b/,
      // Wrapper packages: react-adsense, vue-google-adsense, @ctrl/ngx-adsense…
      pkg('(?:@[\\w-]+\\/)?[\\w-]*adsense[\\w-]*'),
    ],
  },
  {
    name: 'Google Ad Manager (GPT)',
    patterns: [
      /securepubads\.g\.doubleclick\.net/i,
      /\b(?:ad|pubads\.g|googleads\.g|static)\.doubleclick\.net/i,
      /googletagservices\.com\/tag\/js\/gpt\.js/i,
      /\bgoogletag\s*\.\s*(?:pubads|defineSlot|defineOutOfPageSlot|enableServices)\s*\(/,
      pkg('@guardian\\/commercial(?:-core)?|@adslot\\/react-gpt'),
    ],
  },
  {
    name: 'Google IMA SDK',
    patterns: [
      /imasdk\.googleapis\.com/i,
      /\bgoogle\s*\.\s*ima\s*\.\s*(?:AdsLoader|AdDisplayContainer|AdsRequest|AdsManager|ImaSdkSettings|AdsManagerLoadedEvent)\b/,
      pkg('videojs-ima|@dailymotion\\/vast-client'),
    ],
  },
  {
    // H5 Games Ads / AdMob for web games: `adBreak({ type: 'next', … })` and
    // `adConfig({ preloadAdBreaks: … })`. A function merely named adBreak passes.
    name: 'Google H5 Games Ads / AdMob',
    patterns: [
      /\badBreak\s*\(\s*\{[^}]*\btype\s*:\s*['"`](?:start|pause|next|browse|reward|preroll)['"`]/,
      /\badConfig\s*\(\s*\{[^}]*\bpreloadAdBreaks\s*:/,
      pkg(
        '@capacitor-community\\/admob|cordova-plugin-admob(?:-free|-plus)?|(?:@[\\w-]+\\/)?(?:react-native-)?google-mobile-ads',
      ),
    ],
  },
  {
    name: 'Amazon Publisher Services',
    patterns: [
      /amazon-adsystem\.com/i,
      /\bapstag\s*\.\s*(?:init|fetchBids|setDisplayBids|targetingKeys)\s*\(/,
    ],
  },
  {
    name: 'Prebid.js',
    patterns: [
      /\bpbjs\s*\.\s*(?:requestBids|addAdUnits|setConfig|setTargetingForGPTAsync)\s*\(/,
      /\bprebid(?:\.min)?\.js\b/i,
      pkg('prebid\\.js'),
    ],
  },
  { name: 'Media.net', patterns: [/\b(?:contextual|static|warp)\.media\.net\b/i] },
  {
    name: 'Carbon Ads',
    patterns: [
      /\bcarbonads\.(?:com|net)\b/i,
      pkg('vue-carbonads|react-carbonads|svelte-carbonads'),
    ],
  },
  { name: 'BuySellAds', patterns: [/buysellads\.(?:com|net)\b/i, /\b_bsa\s*\.\s*init\s*\(/] },
  {
    name: 'EthicalAds',
    patterns: [/\bethicalads\.io\b/i, /\bdata-ea-publisher\s*=/i, /\bethicalads\s*\.\s*load/i],
  },
  { name: 'Ezoic', patterns: [/\bezoic\.(?:net|com)\b/i, /\bezojs\.com\b/i, /\bezstandalone\b/] },
  { name: 'PropellerAds', patterns: [/\bpropellerads\.com\b/i] },
  { name: 'Adsterra', patterns: [/\badsterra\.com\b/i, /\bhighperformanceformat\.com\b/i] },
  {
    name: 'Taboola',
    patterns: [/\btaboola\.com\b/i, /\bwindow\._taboola\b|\b_taboola\s*\.\s*push\s*\(/],
  },
  { name: 'Outbrain', patterns: [/\boutbrain\.com\b/i, /\bOBR\s*\.\s*extern\b/] },
  // Web-game portal ad SDKs. Shipping one of these turns on interstitial and
  // rewarded ads inside the game.
  {
    name: 'Poki SDK ads',
    patterns: [/game-cdn\.poki\.com/i, /\bPokiSDK\s*\.\s*(?:commercialBreak|rewardedBreak)\s*\(/],
  },
  {
    name: 'CrazyGames SDK ads',
    patterns: [/sdk\.crazygames\.com/i, /\bCrazyGames\s*\.\s*SDK\s*\.\s*ad\b/],
  },
  {
    name: 'GameDistribution SDK',
    patterns: [/\bgamedistribution\.com\b/i, /\bgdsdk\s*\.\s*showAd\s*\(/],
  },
  { name: 'GameMonetize SDK', patterns: [/\bgamemonetize\.com\b/i] },
];

/** Names of ad networks whose patterns match `content` (already comment-stripped). */
export function matchAdNetworks(content: string): string[] {
  return AD_NETWORKS.filter((n) => n.patterns.some((re) => re.test(content))).map((n) => n.name);
}

export const NO_ADS_SUGGESTIONS = [
  'FreeAppStore apps show no ads: remove the ad network script, SDK or package.',
  'To earn from an app, publish it on ProAppStore (https://proappstore.online), which handles subscriptions and creator payouts.',
];

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.html', '.json']);

// Tests and e2e specs may name the networks they assert are absent.
function isTestFile(path: string): boolean {
  return (
    /(?:^|\/)(?:test|tests|__tests__|e2e)\//.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}

export async function checkNoAds(source: FileSource): Promise<CheckResult> {
  const hits: { file: string; matches: string[] }[] = [];

  for await (const path of source.list()) {
    const ext = extOf(path);
    if (!SCAN_EXTS.has(ext) || isTestFile(path)) continue;
    const raw = await source.read(path);
    if (!raw) continue;
    // Comments only, not strings: ad tags live inside string literals.
    const matches = matchAdNetworks(stripCommentsForExt(raw, ext));
    if (matches.length > 0) hits.push({ file: path, matches });
  }

  if (hits.length === 0) {
    return {
      name: 'No ads',
      status: 'pass',
      detail: 'no ad network scripts, SDKs or packages found',
    };
  }

  return {
    name: 'No ads',
    status: 'fail',
    detail: `${hits.length} file(s) load ad networks: ${hits
      .slice(0, 3)
      .map((h) => `${h.file} (${h.matches.join(', ')})`)
      .join('; ')}${hits.length > 3 ? '…' : ''}`,
    suggestions: NO_ADS_SUGGESTIONS,
  };
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

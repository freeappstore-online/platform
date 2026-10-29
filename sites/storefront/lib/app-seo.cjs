// Search-facing metadata for the per-app detail pages (/apps/<id>):
// <title>, meta/og description and the WebApplication JSON-LD.
//
// Pure functions over a registry entry plus data/app-kinds.json (id -> short
// generic "what it is" phrase, e.g. forktuner -> "Instrument tuner"). Kinds live
// in their own file because registry.json is rewritten by provisioning commits.
//
// Claims rule: only say what the data supports. The registry carries no
// verified "works offline" or "no account needed" signal (requiresAuth is set
// on a handful of apps and its absence proves nothing; the pwa-offline
// compliance check only warns), so this module never adds either claim. Any
// such wording on a page comes from the app's own author-written description.

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 155;
const BRAND = 'FreeAppStore';

// Registry category (lowercased) -> applicationCategory values Google's
// SoftwareApplication docs list. Unmapped categories ("Other") are omitted
// rather than guessed. schema.org has no ProductivityApplication;
// BusinessApplication is the closest supported value.
const CATEGORY_MAP = {
  learning: 'EducationalApplication',
  'brain training': 'EducationalApplication',
  discovery: 'ReferenceApplication',
  'news & weather': 'ReferenceApplication',
  social: 'SocialNetworkingApplication',
  utilities: 'UtilitiesApplication',
  productivity: 'BusinessApplication',
  'health & fitness': 'HealthApplication',
  finance: 'FinanceApplication',
  lifestyle: 'LifestyleApplication',
  strategy: 'GameApplication',
  creative: 'MultimediaApplication',
};

const ACRONYMS = new Set(['ai', 'asmr', 'csv', 'hiit', 'json', 'mcp', 'midi', 'pdf', 'qr', 'rpg', 'url']);
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'your']);

const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Registry names that are all-lowercase slugs ("periodic-table") become "Periodic Table"; anything else is the author's casing. */
function displayName(name) {
  const n = cleanText(name);
  if (!n || n !== n.toLowerCase()) return n;
  return n.split(/[\s_-]+/).filter(Boolean)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** "Stopwatch and countdown timer" -> "Stopwatch and Countdown Timer"; existing capitals (JSON, K-pop) are kept. */
function titleCase(phrase) {
  return cleanText(phrase).split(' ')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Kind as it reads mid-sentence: "Instrument tuner" -> "instrument tuner", but "JSON formatter" / "K-pop diary" stay. */
function sentenceKind(kind) {
  const k = cleanText(kind);
  return /^[A-Z][A-Z-]/.test(k) ? k : k.charAt(0).toLowerCase() + k.slice(1);
}

function lookupKind(app, kinds) {
  const k = kinds && Object.prototype.hasOwnProperty.call(kinds, app.id) ? cleanText(kinds[app.id]) : '';
  return k || null;
}

function seoTitle(app, kind) {
  const dn = displayName(app.name);
  const candidates = [];
  if (kind) {
    const K = titleCase(kind);
    // "Calculator: Free Calculator" reads as spam; when the kind already names
    // the app, lead with the kind instead.
    const lead = K.toLowerCase().includes(dn.toLowerCase()) ? `Free ${K} Online` : `${dn}: Free ${K}`;
    // Shed ", No Ads", then the brand suffix, before giving up on the kind.
    candidates.push(`${lead}, No Ads | ${BRAND}`, `${lead} | ${BRAND}`, lead);
  }
  candidates.push(`${dn}: Free Web App | ${BRAND}`, `${dn} | ${BRAND}`);
  return candidates.find((t) => t.length <= TITLE_MAX) ?? candidates[candidates.length - 1];
}

/** Author description, tidied: single spaces, capitalised, ends with punctuation. */
function normalizeDescription(desc) {
  let d = cleanText(desc);
  if (!d) return '';
  d = d.charAt(0).toUpperCase() + d.slice(1);
  if (!/[.!?…]$/.test(d)) d += '.';
  return d;
}

/** Cut at a word boundary to `max` chars (ellipsis included). */
function truncate(text, max = DESCRIPTION_MAX) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space > max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:—–-]+$/, '').replace(/[.!?]$/, '') + '…';
}

function seoDescription(app, kind) {
  const d = normalizeDescription(app.description);
  // Every app is free (Offer price 0); say so once, and only if the author hasn't.
  // The kind is only repeated when the description doesn't already name it.
  let lead = '';
  if (!/(^|[^\w-])free\b/i.test(d)) { // "ad-free" is not a price claim
    lead = kind && !d.toLowerCase().includes(kind.toLowerCase())
      ? `Free ${sentenceKind(kind)} in your browser. `
      : 'Free web app. ';
  }
  return truncate(`${lead}${d}`.trim());
}

function applicationCategory(category) {
  return CATEGORY_MAP[cleanText(category).toLowerCase()] ?? null;
}

/** JSON-LD object for a WebApplication (a SoftwareApplication subtype Google accepts). */
function jsonLdObject(app, { size } = {}) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: displayName(app.name),
    description: normalizeDescription(app.description),
  };
  const cat = applicationCategory(app.category);
  if (cat) ld.applicationCategory = cat;
  ld.operatingSystem = 'Any (web browser)';
  if (app.appUrl) ld.url = app.appUrl;
  ld.image = 'https://freeappstore.online/icon-512.png';
  if (size) ld.fileSize = size;
  ld.offers = { '@type': 'Offer', price: '0', priceCurrency: 'USD' };
  ld.isAccessibleForFree = true;
  if (app.repo && /^[\w.-]+\/[\w.-]+$/.test(app.repo)) ld.sameAs = `https://github.com/${app.repo}`;
  ld.isPartOf = { '@id': 'https://freeappstore.online/#website' };
  return ld;
}

/** Serialise for a <script type="application/ld+json"> body: valid JSON that cannot close the tag. */
function jsonLdScriptBody(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Everything the detail page needs, as plain (unescaped) text except jsonLd, which is script-safe. */
function appSeo(app, kinds, opts = {}) {
  const kind = lookupKind(app, kinds);
  return {
    kind,
    title: seoTitle(app, kind),
    description: seoDescription(app, kind),
    jsonLd: jsonLdScriptBody(jsonLdObject(app, opts)),
  };
}

module.exports = {
  appSeo, displayName, titleCase, seoTitle, seoDescription, normalizeDescription, truncate,
  applicationCategory, jsonLdObject, jsonLdScriptBody, TITLE_MAX, DESCRIPTION_MAX,
};

// App ideas pages (freeappstore.online/ideas and proappstore.online/ideas):
// popular Google Play / App Store app types to rebuild as web apps. One
// dataset (data/app-ideas.json, from docs/app-research/*.md) is rendered by
// both storefronts. Whether an idea can be built here is not hand-labelled:
// it is computed from what the idea requires and what each platform's
// capabilities.json says it supports, so a card names its blocker and links
// to the other store when only that one can build it.
//
// This file is shared verbatim with the ProAppStore storefront
// (proappstore-online/proappstore scripts/ideas.cjs). Change it here and copy
// it there; a test in each repo checks the copies match.

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CATEGORIES = [
  'Productivity', 'Utilities', 'Health & Fitness', 'Finance', 'Education', 'Lifestyle',
  'Photo & Video', 'Music & Audio', 'Developer Tools', 'Travel & Maps', 'Social', 'AI', 'Business',
];
const DECISIONS = ['build-now', 'build-now-upgrade-later', 'upgrade-existing', 'defer', 'wont-build'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const STORES = ['play', 'apple'];
const SOURCES = ['play', 'apple', 'niche', 'pas-research'];
// The capability vocabulary both platforms publish. Labels are what a card
// says when a capability is missing ("Needs scheduled jobs").
const CAPABILITY_LABELS = {
  'static-hosting': 'web hosting',
  'offline-pwa': 'offline install',
  auth: 'sign-in',
  'user-storage': 'synced user data',
  'shared-data': 'shared data between users',
  'private-shared-data': 'private data shared within a group',
  counters: 'shared counters',
  realtime: 'realtime rooms',
  'file-storage': 'file storage',
  email: 'email',
  'push-reminders': 'scheduled reminders',
  'push-triggered': 'push notifications on events',
  'third-party-api-secret': 'secret API keys',
  'ai-user-key': 'AI with your own key',
  'ai-platform': 'built-in AI',
  'server-compute': 'server code',
  'scheduled-jobs': 'scheduled jobs',
  payments: 'payments',
  'webhooks-out': 'outgoing webhooks',
  'webhooks-in': 'incoming webhooks',
  'custom-domain': 'a custom domain',
  'ads-free-tracking-free': 'no ads or tracking',
  'browser-camera': 'the camera',
  'browser-microphone': 'the microphone',
  'browser-geolocation': 'location',
  'browser-sensors': 'motion sensors',
  'browser-bluetooth-usb-serial': 'Bluetooth / USB',
  'browser-screen-capture': 'screen capture',
  'browser-file-access': 'local files',
  'browser-wasm': 'WebAssembly',
  'browser-any-https-api': 'third-party APIs',
};
const CAPABILITY_IDS = Object.keys(CAPABILITY_LABELS);
// Needs the phone's own OS (widgets, launchers, call recording…): no web
// platform can offer it, so it is never in a capabilities.json.
const NATIVE = 'native-os';
const CAP_STATUSES = ['yes', 'limited', 'no'];
// Store links are the only outbound URLs on the page; pin them to the two
// stores so a bad data edit can't turn the page into a link farm.
const STORE_URL_RE = {
  play: /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[A-Za-z0-9._]+(?:&[A-Za-z0-9=._-]+)*$/,
  apple: /^https:\/\/apps\.apple\.com\/[a-z]{2}\/app\/(?:[a-z0-9-]+\/)?id\d+$/,
};
const STORE_LABEL = { play: 'Google Play', apple: 'App Store' };
const DIFFICULTY_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

function text(s, max) {
  return typeof s === 'string' && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
}
function optText(s, max) {
  return s == null || text(s, max);
}
function capList(list, allowNative) {
  return Array.isArray(list) && list.every(c => CAPABILITY_IDS.includes(c) || (allowNative && c === NATIVE));
}

function validateCapabilities(caps) {
  const errors = [];
  if (!caps || typeof caps.capabilities !== 'object') return ['capabilities must be an object'];
  if (!text(caps.platform, 10) || !text(caps.name, 40)) errors.push('platform and name are required');
  for (const id of CAPABILITY_IDS) {
    const c = caps.capabilities[id];
    if (!c) { errors.push(`${caps.platform}: missing capability ${id}`); continue; }
    if (!CAP_STATUSES.includes(c.status)) errors.push(`${caps.platform}: ${id}: bad status ${JSON.stringify(c.status)}`);
    if (!optText(c.limits, 300) || !optText(c.note, 300)) errors.push(`${caps.platform}: ${id}: limits/note too long`);
  }
  for (const id of Object.keys(caps.capabilities)) {
    if (!CAPABILITY_IDS.includes(id)) errors.push(`${caps.platform}: unknown capability ${id}`);
  }
  return errors;
}

function validateIdeas(data) {
  const errors = [];
  if (!data || !Array.isArray(data.ideas)) return ['ideas must be an array'];
  if (!optText(data.researchDate, 20)) errors.push('bad researchDate');
  const seen = new Set();
  for (const idea of data.ideas) {
    const id = idea && idea.id;
    const at = `idea ${JSON.stringify(id)}`;
    if (!id || !ID_RE.test(id)) { errors.push(`${at}: bad id`); continue; }
    if (seen.has(id)) errors.push(`${at}: duplicate id`);
    seen.add(id);
    if (!text(idea.name, 80)) errors.push(`${at}: name must be 1-80 chars`);
    if (!CATEGORIES.includes(idea.category)) errors.push(`${at}: unknown category ${JSON.stringify(idea.category)}`);
    if (!DECISIONS.includes(idea.decision)) errors.push(`${at}: unknown decision ${JSON.stringify(idea.decision)}`);
    if (!DIFFICULTIES.includes(idea.difficulty)) errors.push(`${at}: unknown difficulty ${JSON.stringify(idea.difficulty)}`);
    if (!Number.isInteger(idea.demand) || idea.demand < 1 || idea.demand > 5) errors.push(`${at}: demand must be 1-5`);
    if (idea.wave != null && !(Number.isInteger(idea.wave) && idea.wave >= 1 && idea.wave <= 9)) errors.push(`${at}: bad wave`);
    for (const k of ['pitch', 'fasEdge', 'pasEdge', 'requiresWhy']) {
      if (!optText(idea[k], 300)) errors.push(`${at}: ${k} too long`);
    }
    if (!optText(idea.caveats, 400)) errors.push(`${at}: caveats too long`);
    if (!optText(idea.waitsOn, 120)) errors.push(`${at}: waitsOn too long`);
    if (!optText(idea.heldBy, 120)) errors.push(`${at}: heldBy too long`);
    if (!capList(idea.requires, true)) errors.push(`${at}: requires must be capability ids`);
    if (idea.optional != null && !capList(idea.optional, false)) errors.push(`${at}: optional must be capability ids`);
    if (idea.anyOf != null && !(Array.isArray(idea.anyOf) && idea.anyOf.length > 1 && idea.anyOf.every(set => set.length && capList(set, false)))) {
      errors.push(`${at}: anyOf must be ≥ 2 non-empty sets of capability ids`);
    }
    for (const k of ['fasApps', 'pasApps']) {
      if (idea[k] != null && !(Array.isArray(idea[k]) && idea[k].every(a => typeof a === 'string' && ID_RE.test(a)))) errors.push(`${at}: ${k} must be app ids`);
    }
    if (!Array.isArray(idea.sources) || !idea.sources.every(s => SOURCES.includes(s))) errors.push(`${at}: bad sources`);
    if (!Array.isArray(idea.leaders) || idea.leaders.length > 8) { errors.push(`${at}: leaders must be an array of ≤ 8`); continue; }
    for (const l of idea.leaders) {
      if (!l || !text(l.name, 80)) { errors.push(`${at}: leader needs a name`); continue; }
      if (!STORES.includes(l.store)) errors.push(`${at}: leader ${l.name}: bad store`);
      if (l.url != null && !(STORE_URL_RE[l.store] && STORE_URL_RE[l.store].test(l.url))) errors.push(`${at}: leader ${l.name}: url is not a ${l.store} listing: ${JSON.stringify(l.url)}`);
      if (l.rating != null && !(typeof l.rating === 'number' && l.rating >= 0 && l.rating <= 5)) errors.push(`${at}: leader ${l.name}: bad rating`);
      if (l.chartRank != null && !(Number.isInteger(l.chartRank) && l.chartRank > 0)) errors.push(`${at}: leader ${l.name}: bad chartRank`);
      for (const k of ['installs', 'reviews', 'chart', 'price']) {
        if (!optText(l[k], 40)) errors.push(`${at}: leader ${l.name}: bad ${k}`);
      }
    }
  }
  return errors;
}

// Can `caps` build `idea`? → { kind: 'native' | 'blocked' | 'limited' | 'ok',
// missing: [cap ids], limited: [cap ids] }. An anyOf group uses the set
// missing the fewest capabilities, then the one with the fewest limited ones,
// so an unrestricted option wins over a quota-bound one.
function verdictFor(idea, caps) {
  if (idea.requires.includes(NATIVE)) return { kind: 'native', missing: [], limited: [] };
  const has = id => caps.capabilities[id] && caps.capabilities[id].status !== 'no';
  let needed = idea.requires.slice();
  if (idea.anyOf) {
    const ranked = idea.anyOf
      .map(set => ({
        set,
        missing: set.filter(c => !has(c)).length,
        limited: set.filter(c => has(c) && caps.capabilities[c].status === 'limited').length,
      }))
      .sort((a, b) => a.missing - b.missing || a.limited - b.limited);
    needed = needed.concat(ranked[0].set);
  }
  const missing = needed.filter(c => !has(c));
  if (missing.length) return { kind: 'blocked', missing, limited: [] };
  const limited = needed.filter(c => caps.capabilities[c].status === 'limited');
  return { kind: limited.length ? 'limited' : 'ok', missing: [], limited };
}
function buildable(v) {
  return v.kind === 'ok' || v.kind === 'limited';
}

// The status a card filters on. "open" = buildable here and nothing in this
// store covers it yet — the ideas we most want creators to pick up.
function statusOf(idea, here, other, liveApps) {
  const v = verdictFor(idea, here.caps);
  if (v.kind === 'native') return 'native';
  // Held back by something no platform capability covers (licensed content).
  if (idea.heldBy) return 'held';
  if (!buildable(v)) return other && buildable(verdictFor(idea, other.caps)) ? 'other' : 'blocked';
  // The research picked an existing FAS app to improve rather than a new one.
  if (liveApps.length) return here.key === 'fas' && idea.decision === 'upgrade-existing' ? 'upgrade' : 'covered';
  return 'open';
}

function capPhrase(ids) {
  const labels = [...new Set(ids)].map(c => CAPABILITY_LABELS[c] || c);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0];
}

function leaderLine(l, escapeHtml) {
  const stats = [];
  if (l.installs) stats.push(`${escapeHtml(l.installs)} installs`);
  if (l.chartRank) stats.push(`#${l.chartRank}${l.chart ? ` ${escapeHtml(l.chart)}` : ''}`);
  if (l.rating != null) stats.push(`${l.rating.toFixed(1)}★`);
  if (l.reviews) stats.push(`${escapeHtml(l.reviews)} reviews`);
  if (l.price) stats.push(escapeHtml(l.price));
  const name = l.url
    ? `<a href="${escapeHtml(l.url)}" rel="noopener nofollow" target="_blank">${escapeHtml(l.name)}</a>`
    : escapeHtml(l.name);
  return `<li><span class="ideas-store ideas-store-${l.store}">${STORE_LABEL[l.store]}</span> <span class="ideas-leader-name">${name}</span>${stats.length ? ` <span class="ideas-leader-stats">${stats.join(' · ')}</span>` : ''}</li>`;
}

// What a builder should use on this platform, with its limits.
function capabilityNotes(idea, here, v, escapeHtml) {
  const wanted = [...new Set([...idea.requires, ...(idea.anyOf ? idea.anyOf.flat() : []), ...(idea.optional || [])])]
    .filter(c => c !== NATIVE && here.caps.capabilities[c] && here.caps.capabilities[c].status !== 'no');
  return wanted.map(c => {
    const cap = here.caps.capabilities[c];
    const extra = [cap.limits, cap.note].filter(Boolean).map(escapeHtml).join('. ');
    const flag = v.limited.includes(c) ? ' ideas-cap-limited' : '';
    return `<li class="ideas-cap${flag}"><strong>${escapeHtml(CAPABILITY_LABELS[c])}</strong>${extra ? `: ${extra}` : ''}</li>`;
  }).join('');
}

function buildPrompt(idea, here, liveApps) {
  const leaders = idea.leaders.map(l => `${l.name} (${STORE_LABEL[l.store]})`).join(', ');
  const usable = [...new Set([...idea.requires, ...(idea.anyOf ? idea.anyOf.flat() : []), ...(idea.optional || [])])]
    .filter(c => here.caps.capabilities[c] && here.caps.capabilities[c].status !== 'no')
    .map(c => {
      const cap = here.caps.capabilities[c];
      return `${CAPABILITY_LABELS[c]}${cap.limits ? ` (${cap.limits})` : ''}`;
    });
  const edge = here.key === 'pas' ? idea.pasEdge : idea.fasEdge;
  return [
    `Build a ${here.name} web app: ${idea.name}.`,
    idea.pitch ? `Why people want it: ${idea.pitch}` : '',
    leaders ? `Market leaders to match or beat: ${leaders}.` : '',
    edge ? `Our edge: ${edge}` : '',
    usable.length ? `${here.name} capabilities to use: ${usable.join('; ')}.` : '',
    idea.caveats ? `Watch out for: ${idea.caveats}` : '',
    liveApps.length ? `Existing ${here.name} apps in this space (go beyond them): ${liveApps.map(a => a.name).join(', ')}.` : '',
    here.buildHint,
  ].filter(Boolean).join('\n');
}

function renderCard(idea, here, other, escapeHtml) {
  const liveApps = (idea[here.appsField] || []).map(id => here.appsById.get(id)).filter(Boolean);
  const status = statusOf(idea, here, other, liveApps);
  const v = verdictFor(idea, here.caps);
  const ov = other ? verdictFor(idea, other.caps) : null;
  const otherLink = other ? `<a href="${other.ideasUrl}#idea-${idea.id}">${escapeHtml(other.name)} →</a>` : '';
  const dots = Array.from({ length: 5 }, (_, i) => `<span class="${i < idea.demand ? 'on' : ''}"></span>`).join('');

  const badges = [];
  if (status === 'open') badges.push(`<span class="ideas-badge ideas-badge-open">Not on ${escapeHtml(here.name)} yet</span>`);
  if (status === 'upgrade') badges.push('<span class="ideas-badge ideas-badge-upgrade">Build a better one</span>');
  if (status === 'native') badges.push('<span class="ideas-badge ideas-badge-wont">Not possible as a web app</span>');
  if (status === 'held') badges.push(`<span class="ideas-badge ideas-badge-defer">On hold: ${escapeHtml(idea.heldBy)}</span>`);
  if (status === 'blocked') badges.push(`<span class="ideas-badge ideas-badge-defer">Blocked: needs ${escapeHtml(capPhrase(v.missing))}</span>`);
  if (status === 'other') badges.push(`<span class="ideas-badge ideas-badge-other">Needs ${escapeHtml(capPhrase(v.missing))}</span>`);
  if (v.kind === 'limited') badges.push(`<span class="ideas-badge ideas-badge-limited">Within limits: ${escapeHtml(capPhrase(v.limited))}</span>`);
  // The other store can build it too: on PAS that means "you could ship it
  // free on FAS"; on FAS it is not worth a badge.
  const canBuild = buildable(v) && status !== 'held';
  const exclusive = here.key === 'pas' && canBuild && ov && !buildable(ov);
  if (exclusive) badges.push(`<span class="ideas-badge ideas-badge-exclusive">Only on ${escapeHtml(here.name)}</span>`);
  badges.push(`<span class="ideas-badge ideas-diff-${idea.difficulty}">${DIFFICULTY_LABEL[idea.difficulty]}</span>`);

  // Say what the limit is right on the card, not only in Build notes.
  const limitsLine = v.kind === 'limited'
    ? `<p class="ideas-limits"><strong>Limits on ${escapeHtml(here.name)}:</strong> ${v.limited.map(c => {
      const cap = here.caps.capabilities[c];
      const extra = [cap.limits, cap.note].filter(Boolean).map(escapeHtml).join('. ');
      return `${escapeHtml(CAPABILITY_LABELS[c])}${extra ? ` (${extra})` : ''}`;
    }).join('; ')}</p>`
    : '';

  let crossLine = '';
  if (status === 'other') {
    crossLine = `<p class="ideas-cross ideas-cross-go">${escapeHtml(here.name)} can't build this yet: it needs ${escapeHtml(capPhrase(v.missing))}. <strong>Build it on ${otherLink}</strong></p>`;
  } else if (here.key === 'pas' && canBuild && ov && buildable(ov)) {
    crossLine = `<p class="ideas-cross">Needs nothing paid: you could also publish it free on ${otherLink}</p>`;
  } else if (status === 'blocked') {
    crossLine = `<p class="ideas-cross">Neither store can build this yet: it needs ${escapeHtml(capPhrase(v.missing))}.</p>`;
  }

  const onHere = liveApps.length
    ? `<p class="ideas-onfas">On ${escapeHtml(here.name)}: ${liveApps.map(a => `<a href="${here.appHref(a.id)}">${escapeHtml(a.name)}</a>`).join(', ')}</p>`
    : '';
  const notes = canBuild ? capabilityNotes(idea, here, v, escapeHtml) : '';
  const details = [];
  if (idea.requiresWhy) details.push(`<p>${escapeHtml(idea.requiresWhy)}</p>`);
  if (notes) details.push(`<p><strong>Use on ${escapeHtml(here.name)}:</strong></p><ul class="ideas-caps">${notes}</ul>`);
  if (idea.caveats) details.push(`<p><strong>Watch out for:</strong> ${escapeHtml(idea.caveats)}</p>`);
  const edge = here.key === 'pas' ? idea.pasEdge : idea.fasEdge;
  const searchText = [idea.name, idea.category, idea.pitch, ...idea.leaders.map(l => l.name), ...liveApps.map(a => a.name)]
    .filter(Boolean).join(' ').toLowerCase();

  return `<article class="ideas-card ideas-status-${status}" id="idea-${idea.id}" data-id="${idea.id}" data-status="${status}" data-exclusive="${exclusive ? 1 : 0}" data-category="${escapeHtml(idea.category)}" data-demand="${idea.demand}" data-difficulty="${DIFFICULTIES.indexOf(idea.difficulty)}" data-wave="${idea.wave || 9}" data-decision="${DECISIONS.indexOf(idea.decision)}" data-search="${escapeHtml(searchText)}">
  <div class="ideas-card-head">
    <div>
      <h3><a href="#idea-${idea.id}">${escapeHtml(idea.name)}</a></h3>
      <span class="ideas-cat">${escapeHtml(idea.category)}</span>
    </div>
    <div class="ideas-demand" title="Demand ${idea.demand} of 5, from installs and chart position" aria-label="Demand ${idea.demand} of 5">${dots}</div>
  </div>
  <div class="ideas-badges">${badges.join('')}</div>
  ${idea.pitch ? `<p class="ideas-pitch">${escapeHtml(idea.pitch)}</p>` : ''}
  ${edge ? `<p class="ideas-edge"><strong>${escapeHtml(here.edgeLabel)}</strong> ${escapeHtml(edge)}</p>` : ''}
  ${limitsLine}
  ${crossLine}
  ${idea.leaders.length ? `<ul class="ideas-leaders" aria-label="Market leaders">${idea.leaders.map(l => leaderLine(l, escapeHtml)).join('')}</ul>` : ''}
  ${onHere}
  ${details.length ? `<details class="ideas-details"><summary>Build notes</summary>${details.join('')}</details>` : ''}
  ${canBuild ? `<div class="ideas-actions"><button type="button" class="ideas-copy" data-prompt="${escapeHtml(buildPrompt(idea, here, liveApps))}">Copy build prompt</button><code>${escapeHtml(here.initCommand(idea.id))}</code><div class="ideas-claim" data-idea="${idea.id}" hidden></div></div>` : ''}
</article>`;
}

// here / other: { key, name, caps (capabilities.json), ideasUrl } plus, for
// here: apps [{id,name}], appsField ('fasApps'|'pasApps'), appHref(id),
// initCommand(id), buildHint, edgeLabel. other may be null (no cross-links).
function renderIdeasPage(template, data, here, other, escapeHtml) {
  here = { ...here, appsById: new Map(here.apps.map(a => [a.id, a])) };
  const ideas = data.ideas;
  const statuses = ideas.map(i => statusOf(i, here, other, (i[here.appsField] || []).filter(id => here.appsById.has(id))));
  const count = (...s) => statuses.filter(x => s.includes(x)).length;
  // Buildable here but not on the other store ("Pro only" on PAS).
  const exclusiveCount = other
    ? ideas.filter((i, n) => ['open', 'covered', 'upgrade'].includes(statuses[n]) && !buildable(verdictFor(i, other.caps))).length
    : 0;
  const groups = [
    ['open', `Not on ${here.name} yet`, ['open']],
    ['upgrade', 'Build a better one', ['upgrade']],
    ['buildable', 'All buildable here', ['open', 'covered', 'upgrade']],
    ['other', other ? `Build on ${other.name}` : '', ['other']],
    ['blocked', 'Not possible yet', ['blocked', 'held']],
    ['native', 'Needs a native app', ['native']],
    ['all', 'All', null],
  ].filter(([key, , s]) => key === 'all' || count(...s) > 0);
  const statusButtons = groups.map(([key, label, s], i) =>
    `<button class="filter-btn${i === 0 ? ' active' : ''}" type="button" data-status="${key}" data-statuses="${s ? s.join(' ') : ''}" aria-pressed="${i === 0}">${escapeHtml(label)} <span class="ideas-btn-count">${s ? count(...s) : ideas.length}</span></button>`
  ).join('\n          ');
  const usedCategories = CATEGORIES.filter(c => ideas.some(i => i.category === c));
  const categoryButtons = usedCategories
    .map(c => `<button class="filter-btn" type="button" data-category="${escapeHtml(c)}" aria-pressed="false">${escapeHtml(c)}</button>`)
    .join('\n          ');
  const values = {
    IDEAS_CARDS: ideas.map(i => renderCard(i, here, other, escapeHtml)).join('\n'),
    IDEAS_STATUS_BUTTONS: statusButtons,
    IDEAS_CATEGORY_BUTTONS: categoryButtons,
    IDEAS_COUNT: String(ideas.length),
    IDEAS_OPEN_COUNT: String(count('open')),
    IDEAS_READY_COUNT: String(count('open', 'covered', 'upgrade')),
    IDEAS_OTHER_COUNT: String(count('other')),
    IDEAS_EXCLUSIVE_COUNT: String(exclusiveCount),
    IDEAS_RESEARCH_DATE: escapeHtml(data.researchDate || 'the research date'),
    IDEAS_CAPS_VERIFIED: escapeHtml(here.caps.verifiedAt || 'recently'),
  };
  // One pass with a function replacer: rendered text is never re-scanned for
  // placeholders, and `$&` / `$'` in it are not replacement patterns.
  return template.replace(/{{(IDEAS_[A-Z_]+)}}/g, (m, k) => (k in values ? values[k] : m));
}

module.exports = {
  validateIdeas, validateCapabilities, renderIdeasPage, verdictFor, statusOf,
  CAPABILITY_IDS, CAPABILITY_LABELS, CATEGORIES, DECISIONS, NATIVE,
};

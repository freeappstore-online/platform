// App ideas page (/ideas): popular Google Play / App Store app types that
// creators can rebuild as free FAS apps. Source of truth is
// data/app-ideas.json, extracted from docs/app-research/*.md. The cards are
// rendered at build time (crawlable, works without JS); /ideas.js only
// filters and sorts them.

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CATEGORIES = [
  'Productivity', 'Utilities', 'Health & Fitness', 'Finance', 'Education', 'Lifestyle',
  'Photo & Video', 'Music & Audio', 'Developer Tools', 'Travel & Maps', 'Social', 'AI',
];
const DECISIONS = ['build-now', 'build-now-upgrade-later', 'upgrade-existing', 'defer', 'wont-build'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const STORES = ['play', 'apple'];
const SOURCES = ['play', 'apple', 'niche'];
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
    if (!optText(idea.pitch, 300)) errors.push(`${at}: pitch too long`);
    if (!optText(idea.fasEdge, 300)) errors.push(`${at}: fasEdge too long`);
    if (!optText(idea.caveats, 400)) errors.push(`${at}: caveats too long`);
    if (!optText(idea.waitsOn, 120)) errors.push(`${at}: waitsOn too long`);
    if (!Array.isArray(idea.features) || !idea.features.every(f => text(f, 40))) errors.push(`${at}: features must be short strings`);
    if (!Array.isArray(idea.fasApps) || !idea.fasApps.every(a => typeof a === 'string' && ID_RE.test(a))) errors.push(`${at}: fasApps must be app ids`);
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

// Status buckets the page filters on. "open" = buildable and nothing on FAS
// covers it yet — the ideas we most want creators to pick up.
function statusOf(idea, liveApps) {
  if (idea.decision === 'wont-build') return 'wont';
  if (idea.decision === 'defer') return 'defer';
  if (idea.decision === 'upgrade-existing') return 'upgrade';
  return liveApps.length ? 'covered' : 'open';
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

function buildPrompt(idea, liveApps) {
  const leaders = idea.leaders.map(l => `${l.name} (${STORE_LABEL[l.store]})`).join(', ');
  return [
    `Build a free FreeAppStore web app: ${idea.name}.`,
    idea.pitch ? `Why people want it: ${idea.pitch}` : '',
    leaders ? `Market leaders to match or beat: ${leaders}.` : '',
    idea.fasEdge ? `Our edge: ${idea.fasEdge}` : 'Our edge: free forever, no ads, no tracking, works offline in the browser.',
    idea.features.length ? `FreeAppStore features to use: ${idea.features.join(', ')}.` : '',
    idea.caveats ? `Watch out for: ${idea.caveats}` : '',
    liveApps.length ? `Existing FreeAppStore apps in this space (go beyond them): ${liveApps.map(a => a.name).join(', ')}.` : '',
    'Scaffold with `fas init`, run `fas check` before `fas publish`. Guide: https://freeappstore.online/skills.md',
  ].filter(Boolean).join('\n');
}

function renderCard(idea, appsById, escapeHtml) {
  const liveApps = idea.fasApps.map(id => appsById.get(id)).filter(Boolean);
  const status = statusOf(idea, liveApps);
  const dots = Array.from({ length: 5 }, (_, i) => `<span class="${i < idea.demand ? 'on' : ''}"></span>`).join('');
  const badges = [];
  if (status === 'open') badges.push('<span class="ideas-badge ideas-badge-open">Not on FreeAppStore yet</span>');
  if (status === 'upgrade') badges.push('<span class="ideas-badge ideas-badge-upgrade">Improve an existing app</span>');
  if (status === 'defer') badges.push(`<span class="ideas-badge ideas-badge-defer">Coming soon${idea.waitsOn ? `: needs ${escapeHtml(idea.waitsOn)}` : ''}</span>`);
  if (status === 'wont') badges.push(`<span class="ideas-badge ideas-badge-wont">Not possible as a web app${idea.waitsOn ? `: ${escapeHtml(idea.waitsOn)}` : ''}</span>`);
  if (idea.decision === 'build-now-upgrade-later' && idea.waitsOn) badges.push(`<span class="ideas-badge">Later: ${escapeHtml(idea.waitsOn)}</span>`);
  badges.push(`<span class="ideas-badge ideas-diff-${idea.difficulty}">${DIFFICULTY_LABEL[idea.difficulty]}</span>`);

  const onFas = liveApps.length
    ? `<p class="ideas-onfas">On FreeAppStore: ${liveApps.map(a => `<a href="/apps/${encodeURIComponent(a.id)}">${escapeHtml(a.name)}</a>`).join(', ')}</p>`
    : '';
  const details = [];
  if (idea.features.length) details.push(`<p><strong>FreeAppStore features:</strong> ${idea.features.map(escapeHtml).join(', ')}</p>`);
  if (idea.caveats) details.push(`<p><strong>Watch out for:</strong> ${escapeHtml(idea.caveats)}</p>`);
  const buildable = status !== 'defer' && status !== 'wont';
  const searchText = [idea.name, idea.category, idea.pitch, ...idea.leaders.map(l => l.name), ...liveApps.map(a => a.name)]
    .filter(Boolean).join(' ').toLowerCase();

  return `<article class="ideas-card ideas-status-${status}" id="idea-${idea.id}" data-id="${idea.id}" data-status="${status}" data-category="${escapeHtml(idea.category)}" data-demand="${idea.demand}" data-difficulty="${DIFFICULTIES.indexOf(idea.difficulty)}" data-wave="${idea.wave || 9}" data-decision="${DECISIONS.indexOf(idea.decision)}" data-search="${escapeHtml(searchText)}">
  <div class="ideas-card-head">
    <div>
      <h3><a href="#idea-${idea.id}">${escapeHtml(idea.name)}</a></h3>
      <span class="ideas-cat">${escapeHtml(idea.category)}</span>
    </div>
    <div class="ideas-demand" title="Demand ${idea.demand} of 5, from installs and chart position" aria-label="Demand ${idea.demand} of 5">${dots}</div>
  </div>
  <div class="ideas-badges">${badges.join('')}</div>
  ${idea.pitch ? `<p class="ideas-pitch">${escapeHtml(idea.pitch)}</p>` : ''}
  ${idea.fasEdge ? `<p class="ideas-edge"><strong>Why a free version wins:</strong> ${escapeHtml(idea.fasEdge)}</p>` : ''}
  ${idea.leaders.length ? `<ul class="ideas-leaders" aria-label="Market leaders">${idea.leaders.map(l => leaderLine(l, escapeHtml)).join('')}</ul>` : ''}
  ${onFas}
  ${details.length ? `<details class="ideas-details"><summary>Build notes</summary>${details.join('')}</details>` : ''}
  ${buildable ? `<div class="ideas-actions"><button type="button" class="ideas-copy" data-prompt="${escapeHtml(buildPrompt(idea, liveApps))}">Copy build prompt</button><code>fas init ${idea.id}</code></div>` : ''}
</article>`;
}

function renderIdeasPage(template, data, apps, escapeHtml) {
  const appsById = new Map(apps.map(a => [a.id, a]));
  const ideas = data.ideas;
  const statuses = ideas.map(i => statusOf(i, i.fasApps.filter(id => appsById.has(id))));
  const usedCategories = CATEGORIES.filter(c => ideas.some(i => i.category === c));
  const categoryButtons = usedCategories
    .map(c => `<button class="filter-btn" type="button" data-category="${escapeHtml(c)}" aria-pressed="false">${escapeHtml(c)}</button>`)
    .join('\n          ');
  return template
    .replace('{{IDEAS_CARDS}}', ideas.map(i => renderCard(i, appsById, escapeHtml)).join('\n'))
    .replace('{{IDEAS_CATEGORY_BUTTONS}}', categoryButtons)
    .replaceAll('{{IDEAS_COUNT}}', String(ideas.length))
    .replace('{{IDEAS_OPEN_COUNT}}', String(statuses.filter(s => s === 'open').length))
    .replace('{{IDEAS_READY_COUNT}}', String(statuses.filter(s => s === 'open' || s === 'covered' || s === 'upgrade').length))
    .replace('{{IDEAS_RESEARCH_DATE}}', escapeHtml(data.researchDate || 'the research date'));
}

module.exports = { validateIdeas, renderIdeasPage, statusOf, CATEGORIES, DECISIONS };

// Category landing pages (/category/<slug>): one crawlable page per category
// that has public apps. build.js passes in only public listings (the same
// `apps` list the homepage and sitemap use), so hidden, unpublished and
// monitoring-fixture apps never reach these pages.

const ORIGIN = 'https://freeappstore.online';
// Registry catch-all; a "Free other apps" page is thin and reads badly.
const EXCLUDED_KEYS = new Set(['other (specify in description)', 'other']);
const TITLE_MAX = 65;
const DESCRIPTION_MAX = 155;

/** "Health & Fitness" -> "health-and-fitness". */
function categorySlug(label) {
  return String(label)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Group apps by category, case-insensitively (the registry has both
 * "Lifestyle" and "lifestyle"). Label comes from the first app seen, as on
 * the homepage filter. Sorted by label; empty and excluded categories dropped.
 */
const INDEX_MIN_APPS = 3;

function groupCategories(apps, categoryLabel) {
  const byKey = new Map();
  for (const app of apps) {
    if (typeof app.category !== 'string' || !app.category.trim()) continue;
    const key = app.category.toLowerCase();
    if (EXCLUDED_KEYS.has(key)) continue;
    if (!byKey.has(key)) byKey.set(key, { key, label: categoryLabel(app.category), apps: [] });
    byKey.get(key).apps.push(app);
  }
  const groups = [...byKey.values()].filter((g) => g.apps.length > 0);
  for (const g of groups) {
    g.slug = categorySlug(g.label);
    // A one- or two-app page is thin content: keep it browsable but out of
    // search indexes and the sitemap until the category fills up.
    g.indexable = g.apps.length >= INDEX_MIN_APPS;
    g.url = `${ORIGIN}/category/${g.slug}`;
  }
  const slugs = new Set();
  for (const g of groups) {
    if (!g.slug) throw new Error(`category ${JSON.stringify(g.label)} has an empty slug`);
    if (slugs.has(g.slug)) throw new Error(`two categories share the slug ${JSON.stringify(g.slug)}`);
    slugs.add(g.slug);
  }
  return groups.sort((a, b) => a.label.localeCompare(b.label));
}

function categoryTitle(label) {
  const long = `Free ${label} Apps, No Ads or Subscriptions | FreeAppStore`;
  if (long.length <= TITLE_MAX) return long;
  const short = `Free ${label} Apps, No Ads | FreeAppStore`;
  return short.length <= TITLE_MAX ? short : `Free ${label} Apps | FreeAppStore`;
}

function categoryDescription(label, count) {
  const lower = label.toLowerCase();
  const n = `${count} free ${lower} app${count === 1 ? '' : 's'}`;
  const candidates = [
    `${n} that run in your browser: nothing to download, no ads, no trials, no subscriptions. Open source, on any device.`,
    `${n} that run in your browser: nothing to download, no ads, no subscriptions. Open source.`,
    `${n}: nothing to download, no ads, no subscriptions.`,
  ];
  const fit = candidates.find((d) => d.length <= DESCRIPTION_MAX);
  return fit || candidates[candidates.length - 1].slice(0, DESCRIPTION_MAX);
}

function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

function categoryIntro(group, escapeHtml) {
  const lower = escapeHtml(group.label.toLowerCase());
  const count = group.apps.length;
  const examples = group.apps.slice(0, 3).map((a) => `<a href="/apps/${escapeHtml(a.id)}">${escapeHtml(a.name)}</a>`);
  const browse = count > examples.length
    ? ` Try ${listNames(examples)}, or browse all ${count} below.`
    : ` Try ${listNames(examples)} below.`;
  return `Everyday ${lower} apps, rebuilt for the web: open one in your browser with nothing to download, no ads, no trials and no subscriptions. ` +
    `Every app is open source under the MIT license and takes no payments.${browse}`;
}

/**
 * A card that is itself a link to the app's detail page. Reuses the
 * homepage's compact card classes (.app-card.compact is styled to work as an
 * <a>); data-id keeps the per-app icon background from card-styles.css.
 * No vote button or Open link: those need storefront.js, and a nested <a>
 * would be invalid inside the card link.
 */
function renderCategoryCard(app, { escapeHtml, categoryLabel }) {
  const name = escapeHtml(app.name);
  const letter = escapeHtml((app.name || '?').trim().charAt(0).toUpperCase());
  const iconEmoji = app.icon || `&#${(app.name || '?').codePointAt(0)};`;
  return `        <a class="app-card compact" href="/apps/${escapeHtml(app.id)}" data-id="${escapeHtml(app.id)}">
          <span class="app-icon" data-letter="${letter}">
            <span class="app-emoji" aria-hidden="true">${iconEmoji}</span>
          </span>
          <span class="app-body">
            <span class="app-name"><span class="app-name-text">${name}</span></span>
            <span class="app-meta"><span class="app-cat">${escapeHtml(categoryLabel(app.category))}</span></span>
          </span>
        </a>`;
}

function categoryJsonLd(group, description) {
  const name = `Free ${group.label.toLowerCase()} apps`;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${group.url}#page`,
    url: group.url,
    name,
    description,
    isPartOf: { '@id': `${ORIGIN}/#website` },
    mainEntity: {
      '@type': 'ItemList',
      name,
      numberOfItems: group.apps.length,
      itemListElement: group.apps.map((app, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${ORIGIN}/apps/${app.id}`,
        name: app.name,
      })),
    },
  };
  // Safe inside <script>: no "</script>" or "<!--" can survive.
  return JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
}

function renderCategoryLinks(groups, current, escapeHtml) {
  return groups
    .filter((g) => g.slug !== current.slug)
    .map((g) => `<a class="filter-btn" href="/category/${escapeHtml(g.slug)}">${escapeHtml(g.label)} <span class="category-link-count">${g.apps.length}</span></a>`)
    .join('\n        ');
}

/**
 * Fill the page-specific placeholders of templates/category.html. Shared
 * placeholders (partials, settings bootstrap, beacon, SRI/VER tokens,
 * stylesheet URLs) are left for build.js, as for every other page.
 */
function renderCategoryPage(template, group, groups, { escapeHtml, categoryLabel }) {
  const description = categoryDescription(group.label, group.apps.length);
  const values = {
    CATEGORY_TITLE: escapeHtml(categoryTitle(group.label)),
    CATEGORY_DESCRIPTION: escapeHtml(description),
    CATEGORY_URL: escapeHtml(group.url),
    CATEGORY_ROBOTS: group.indexable === false ? '<meta name="robots" content="noindex, follow" />' : '',
    CATEGORY_HEADING: escapeHtml(`Free ${group.label.toLowerCase()} apps`),
    CATEGORY_INTRO: categoryIntro(group, escapeHtml),
    CATEGORY_LABEL: escapeHtml(group.label),
    CATEGORY_APP_COUNT: String(group.apps.length),
    CATEGORY_CARDS: group.apps.map((app) => renderCategoryCard(app, { escapeHtml, categoryLabel })).join('\n'),
    CATEGORY_LINKS: renderCategoryLinks(groups, group, escapeHtml),
    CATEGORY_JSON_LD: categoryJsonLd(group, description),
  };
  // Single pass so a value containing "{{X}}" is never re-expanded.
  return template.replace(/\{\{(CATEGORY_[A-Z0-9_]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
}

module.exports = {
  categorySlug,
  groupCategories,
  categoryTitle,
  categoryDescription,
  renderCategoryPage,
  TITLE_MAX,
  INDEX_MIN_APPS,
  DESCRIPTION_MAX,
};

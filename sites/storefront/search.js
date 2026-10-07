/**
 * Storefront search — client-side, federated across both stores.
 *
 * Design:
 * - Local cards (already in the DOM) are filtered by toggling [hidden].
 *   Pure DOM manipulation, no re-render.
 * - The OTHER store's registry is embedded at build time in
 *   <script type="application/json" id="cross-store-registry">. We read
 *   it on first input.
 * - Matching is fuzzy-light: case-insensitive substring across id, name,
 *   description, category. No fuzzy-tolerance scoring — keeps things
 *   predictable.
 * - All filtering is local; nothing is fetched at runtime.
 *
 * URL state: typing puts the query in `?q=` (replaceState — no scroll).
 * Refreshing or sharing the URL re-runs the search.
 */
(() => {
  const input = document.getElementById('storefront-search');
  const localGrid = document.getElementById('apps-grid');
  const emptyMsg = document.getElementById('search-empty');
  const crossSection = document.getElementById('cross-store-results');
  const crossGrid = document.getElementById('cross-store-grid');
  if (!input || !localGrid || !emptyMsg || !crossSection || !crossGrid) return;

  const localCards = Array.from(localGrid.querySelectorAll('.app-card'));
  // Pre-build a search-haystack for each local card so input handler
  // doesn't re-read DOM text on every keystroke.
  const localHaystacks = localCards.map((el) => {
    const text = (el.textContent || '').toLowerCase();
    const cat = (el.getAttribute('data-category') || '').toLowerCase();
    return { el, hay: `${text} ${cat}` };
  });

  let crossItems = [];
  try {
    const raw = document.getElementById('cross-store-registry')?.textContent;
    if (raw) {
      const parsed = JSON.parse(raw);
      // Registry shape: { items: [...], domain: 'freegamestore.online',
      // path: 'games' }. Build cards lazily.
      // The other store is a fixed destination, never an arbitrary URL host.
      const validRegistry = parsed.domain === "freegamestore.online"
        && parsed.path === "games" && Array.isArray(parsed.items);
      crossItems = (validRegistry ? parsed.items : []).map((item) => ({
        ...item,
        domain: parsed.domain,
        path: parsed.path,
        hay:
          `${item.id} ${item.name} ${item.description} ${item.category}`.toLowerCase(),
      }));
    }
  } catch (e) {
    // Cross-store registry didn't load — local search still works.
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function categoryLabel(cat) {
    return cat
      .split('-')
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');
  }

  function buildCrossCard(item) {
    const a = document.createElement('a');
    a.className = 'app-card compact cross-store-card';
    // URL path segments: use encodeURIComponent, not HTML-escape. esc() is
    // the wrong context — it'd let `..` or `/` ride through. Build-time
    // validators already constrain `id`, but defense-in-depth.
    a.href = `https://${item.domain}/${encodeURIComponent(item.path)}/${encodeURIComponent(item.id)}.html`;
    a.target = '_blank';
    a.rel = 'noopener';
    // The build assigns each cross-store entry a safe, opaque style id and
    // emits its icon color into card-styles.css. Do not set a runtime style:
    // strict production CSP blocks style attributes, including custom props.
    if (/^cross-\d+$/.test(item.styleId || '')) a.dataset.styleId = item.styleId;
    const letter = (item.name || '?').trim().charAt(0).toUpperCase();
    a.innerHTML = `
      <div class="app-icon">${esc(letter)}</div>
      <div class="app-body">
        <span class="app-name">${esc(item.name)}</span>
        <span class="app-meta">${esc(categoryLabel(item.category))} · on ${esc(item.domain.replace('.online', ''))}</span>
      </div>
      <span class="app-cta" aria-hidden="true">
        <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>
        Open
      </span>
    `;
    return a;
  }

  function applyQuery(q) {
    const needle = q.trim().toLowerCase();
    const activeCat = (typeof window.__fasActiveCategory === 'function')
      ? window.__fasActiveCategory() : 'all';
    let localShown = 0;

    if (needle === '') {
      for (const { el } of localHaystacks) {
        const cat = (el.getAttribute('data-category') || '').toLowerCase();
        const catMatch = activeCat === 'all' || cat === activeCat.toLowerCase();
        el.hidden = !catMatch;
        el.dataset.searchHidden = '0';
        if (!el.hidden) localShown++;
      }
      emptyMsg.hidden = localShown > 0;
      if (typeof window.__fasUpdateAppsCount === 'function') window.__fasUpdateAppsCount(localShown);
      crossSection.hidden = true;
      crossGrid.innerHTML = '';
      return;
    }

    for (const { el, hay } of localHaystacks) {
      const textMatch = hay.includes(needle);
      const cat = (el.getAttribute('data-category') || '').toLowerCase();
      const catMatch = activeCat === 'all' || cat === activeCat.toLowerCase();
      const match = textMatch && catMatch;
      el.hidden = !match;
      el.dataset.searchHidden = textMatch ? '0' : '1';
      if (match) localShown++;
    }
    emptyMsg.hidden = localShown > 0;
    if (typeof window.__fasUpdateAppsCount === 'function') window.__fasUpdateAppsCount(localShown);

    crossGrid.innerHTML = '';
    let crossShown = 0;
    if (needle.length >= 3) {
      for (const item of crossItems) {
        if (!item.hay.includes(needle)) continue;
        crossGrid.appendChild(buildCrossCard(item));
        crossShown++;
        if (crossShown >= 6) break;
      }
    }
    crossSection.hidden = crossShown === 0;
  }

  // Initial: pick up ?q= from URL.
  const initial = new URL(window.location.href).searchParams.get('q') || '';
  if (initial) {
    input.value = initial;
    applyQuery(initial);
  }

  // Live filtering. Debounce is overkill at this scale — local arrays
  // are small enough for synchronous filtering on every keystroke.
  input.addEventListener('input', () => {
    const q = input.value;
    applyQuery(q);
    const url = new URL(window.location.href);
    if (q.trim() === '') url.searchParams.delete('q');
    else url.searchParams.set('q', q);
    window.history.replaceState(null, '', url.toString());
  });
})();

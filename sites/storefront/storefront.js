/**
 * FreeAppStore storefront interactions:
 *   - category filter bar
 *   - sort tabs (Newest / Most popular)
 *   - vote buttons (heart pill on each card)
 *   - split-pane preview with device mode (desktop / tablet / mobile)
 *   - ?app=<id> deep link
 *
 * Vendored — each store ships its own copy. Don't depend across stores.
 */
(function () {
  // ---------- Category filter ----------
  (function () {
    var filterBar = document.getElementById('categoryFilter');
    if (!filterBar) return;
    var activeCategory = 'all';

    filterBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.filter-btn');
      if (!btn) return;
      filterBar.querySelectorAll('.filter-btn').forEach(function (b) {
        b.classList.remove('active');
      });
      btn.classList.add('active');
      activeCategory = btn.dataset.category || 'all';
      var cards = document.querySelectorAll('#apps-grid .app-card');
      var shown = 0;
      cards.forEach(function (card) {
        var cat = (card.getAttribute('data-category') || '').toLowerCase();
        var match = activeCategory === 'all' || cat === activeCategory.toLowerCase();
        var searchHidden = card.dataset.searchHidden === '1';
        card.hidden = !match || searchHidden;
        if (!card.hidden) shown++;
      });
      var empty = document.getElementById('search-empty');
      if (empty) empty.hidden = shown > 0;
    });

    window.__fasActiveCategory = function () { return activeCategory; };
  })();

  // ---------- Sort ----------
  (function () {
    var sortBar = document.getElementById('sortBar');
    if (!sortBar) return;
    var grid = document.getElementById('apps-grid');
    if (!grid) return;

    var activeSort = 'newest';

    function applySort(sort) {
      activeSort = sort;

      // Update active pill.
      sortBar.querySelectorAll('.filter-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.sort === sort);
      });

      // Reflect in URL (same replaceState pattern as search.js).
      try {
        var u = new URL(window.location.href);
        u.searchParams.set('sort', sort);
        window.history.replaceState(null, '', u.toString());
      } catch (e) {}

      // Reorder DOM nodes by moving them in the grid (DOM order, not CSS order).
      // Cards with missing data sort last for determinism.
      var cards = Array.from(grid.querySelectorAll('.app-card'));
      if (sort === 'newest') {
        cards.sort(function (a, b) {
          var pa = a.getAttribute('data-published') || '';
          var pb = b.getAttribute('data-published') || '';
          if (pa === pb) {
            // Tie-break by data-id alphabetically for determinism.
            return (a.getAttribute('data-id') || '').localeCompare(b.getAttribute('data-id') || '');
          }
          // Descending: larger ISO string first (more recent).
          return pa < pb ? 1 : -1;
        });
        cards.forEach(function (card) { grid.appendChild(card); });
      } else if (sort === 'popular') {
        cards.sort(function (a, b) {
          var va = parseInt(a.dataset.votes || '0', 10) || 0;
          var vb = parseInt(b.dataset.votes || '0', 10) || 0;
          if (va !== vb) return vb - va; // descending by votes
          // Tie-break by data-id alphabetically for determinism.
          return (a.getAttribute('data-id') || '').localeCompare(b.getAttribute('data-id') || '');
        });
        cards.forEach(function (card) { grid.appendChild(card); });
      } else if (sort === 'az') {
        cards.sort(function (a, b) {
          var na = a.getAttribute('data-name') || a.getAttribute('data-id') || '';
          var nb = b.getAttribute('data-name') || b.getAttribute('data-id') || '';
          var cmp = na.localeCompare(nb, undefined, { sensitivity: 'base', numeric: true });
          if (cmp !== 0) return cmp;
          // Tie-break by data-id for determinism.
          return (a.getAttribute('data-id') || '').localeCompare(b.getAttribute('data-id') || '');
        });
        cards.forEach(function (card) { grid.appendChild(card); });
      }
    }

    sortBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.filter-btn');
      if (!btn) return;
      var sort = btn.dataset.sort;
      if (!sort) return;
      applySort(sort);
    });

    // Expose so category filter and search can re-trigger sort after reordering.
    window.__fasActiveSort = function () { return activeSort; };

    // Apply sort on load — honour ?sort= URL param, default to newest.
    try {
      var initialSort = new URL(window.location.href).searchParams.get('sort') || 'newest';
      applySort(initialSort);
    } catch (e) {
      applySort('newest');
    }
  })();

  // ---------- Vote counts (load on page open, populate data-votes + counts) ----------
  (function () {
    var API = 'https://api.freeappstore.online';

    // Populate data-votes on all cards and update visible vote-count spans.
    function applyVoteCounts(votes) {
      Object.keys(votes).forEach(function (appId) {
        var count = votes[appId] || 0;
        var card = document.querySelector('.app-card[data-id="' + CSS.escape(appId) + '"]');
        if (!card) return;
        card.dataset.votes = String(count);
        var span = card.querySelector('.vote-btn .vote-count');
        if (span) span.textContent = count > 0 ? String(count) : '0';
      });
    }

    // Fetch aggregate votes once on page load. Resilient — failures leave
    // cards at count 0 and the sort still works (all tied at 0).
    fetch(API + '/v1/store/votes')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.votes && typeof data.votes === 'object') {
          applyVoteCounts(data.votes);
          // If the current sort is 'popular', re-apply so counts are reflected.
          if (typeof window.__fasActiveSort === 'function' && window.__fasActiveSort() === 'popular') {
            // Trigger a re-sort by simulating the sort button click sequence.
            var sortBar = document.getElementById('sortBar');
            if (sortBar) {
              var btn = sortBar.querySelector('[data-sort="popular"]');
              if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
          }
        }
      })
      .catch(function () { /* votes unavailable — cards stay at 0 */ });
  })();

  // ---------- Vote button click handler ----------
  (function () {
    var API = 'https://api.freeappstore.online';
    // voted state is tracked in memory (per page load); a future improvement
    // could use localStorage for cross-session persistence.
    var votedSet = {};

    function getToken() {
      try {
        var raw = localStorage.getItem('fas:session');
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        return (parsed && typeof parsed.token === 'string') ? parsed.token : null;
      } catch (e) { return null; }
    }

    function triggerSignIn() {
      // Same redirect flow as auth.js showSignIn().
      var url = new URL('/v1/auth/github/start', API);
      url.searchParams.set('app_id', 'store');
      url.searchParams.set('return_to', window.location.href);
      window.location.href = url.toString();
    }

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.vote-btn');
      if (!btn) return;
      // Prevent click from propagating to the card body (which opens the preview pane).
      e.stopPropagation();

      var appId = btn.dataset.appId;
      if (!appId) return;

      var token = getToken();
      if (!token) {
        triggerSignIn();
        return;
      }

      var alreadyVoted = !!votedSet[appId];
      var method = alreadyVoted ? 'DELETE' : 'POST';

      // Optimistic update.
      var countSpan = btn.querySelector('.vote-count');
      var current = parseInt(btn.closest('.app-card').dataset.votes || '0', 10) || 0;
      var optimistic = alreadyVoted ? Math.max(0, current - 1) : current + 1;
      if (countSpan) countSpan.textContent = String(optimistic);
      btn.closest('.app-card').dataset.votes = String(optimistic);
      btn.setAttribute('aria-pressed', alreadyVoted ? 'false' : 'true');
      btn.classList.toggle('voted', !alreadyVoted);

      fetch(API + '/v1/store/apps/' + encodeURIComponent(appId) + '/vote', {
        method: method,
        headers: { Authorization: 'Bearer ' + token },
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (data) {
          // Confirm with server count.
          var confirmed = typeof data.count === 'number' ? data.count : optimistic;
          if (countSpan) countSpan.textContent = String(confirmed);
          btn.closest('.app-card').dataset.votes = String(confirmed);
          if (data.voted) {
            votedSet[appId] = true;
          } else {
            delete votedSet[appId];
          }
          btn.setAttribute('aria-pressed', data.voted ? 'true' : 'false');
          btn.classList.toggle('voted', !!data.voted);
        })
        .catch(function () {
          // Roll back optimistic update on error.
          if (countSpan) countSpan.textContent = String(current);
          btn.closest('.app-card').dataset.votes = String(current);
          btn.setAttribute('aria-pressed', alreadyVoted ? 'true' : 'false');
          btn.classList.toggle('voted', alreadyVoted);
        });
    });
  })();

  // ---------- Split-pane preview ----------
  (function () {
    var pane = document.getElementById('previewPane');
    if (!pane) return;
    var SPLIT_MQ = window.matchMedia('(min-width: 1024px)');
    var frame = document.getElementById('previewFrame');
    var empty = document.getElementById('previewEmpty');
    var title = document.getElementById('previewTitle');
    var btnNewTab = document.getElementById('previewNewTab');
    var btnAbout = document.getElementById('previewAbout');
    var btnClose = document.getElementById('previewClose');
    var modeBar = document.getElementById('previewModeBar');
    var current = null; // { id, name, url, aboutUrl }
    var loadTimeout = null;
    var loadToken = 0; // bumped on each loadInPane so stale fetches/timeouts no-op

    // Capture the original empty-state text so we can restore it after an error.
    var emptyTitleEl = empty && empty.querySelector('.empty-title');
    var emptyTipEl = empty && empty.querySelector('.empty-tip');
    var ORIGINAL_EMPTY_TITLE = emptyTitleEl ? emptyTitleEl.textContent : '';
    var ORIGINAL_EMPTY_TIP_HTML = emptyTipEl ? emptyTipEl.innerHTML : '';

    /* SECURITY: the iframe loads app URLs under *.freeappstore.online — all
     * first-party today. Sandbox allows same-origin + scripts because apps need
     * their own cookies / localStorage / fetch to function. Before opening
     * third-party app submissions, revisit this: an untrusted app inside the
     * iframe can currently use its same-origin scope freely. Tightening options
     * include dropping allow-same-origin (breaks stateful apps) or adding
     * `credentialless` once browser support is universal. */
    function restoreEmpty() {
      if (emptyTitleEl) emptyTitleEl.textContent = ORIGINAL_EMPTY_TITLE;
      if (emptyTipEl) emptyTipEl.innerHTML = ORIGINAL_EMPTY_TIP_HTML;
      if (empty) empty.classList.remove('is-error');
    }

    function showLoadError(meta) {
      if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
      pane.classList.remove('is-loading');
      frame.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.classList.add('is-error');
        if (emptyTitleEl) emptyTitleEl.textContent = (meta.name || 'This app') + " can't embed here";
        if (emptyTipEl) emptyTipEl.innerHTML = 'It blocks iframes. Click <strong>↗ New tab</strong> to launch it normally.';
      }
    }

    function activate(card) {
      document.querySelectorAll('.app-card.compact.is-active').forEach(function (c) {
        c.classList.remove('is-active');
      });
      if (card) card.classList.add('is-active');
    }

    function setTitle(name, url) {
      var host = '';
      try { host = url ? new URL(url).host : ''; } catch (e) {}
      title.innerHTML = '';
      title.appendChild(document.createTextNode(name || 'No app selected'));
      if (host) {
        var hs = document.createElement('span');
        hs.className = 'preview-host';
        hs.textContent = host;
        title.appendChild(hs);
      }
    }

    function setUrlParam(value) {
      try {
        var u = new URL(window.location.href);
        if (value) u.searchParams.set('app', value);
        else u.searchParams.delete('app');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      } catch (e) {}
    }

    function showAuthRequired(meta) {
      if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
      pane.classList.remove('is-loading');
      frame.hidden = true;
      if (modeBar) modeBar.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.classList.remove('is-error');
        if (emptyTitleEl) emptyTitleEl.textContent = meta.name + ' requires sign-in';
        if (emptyTipEl) emptyTipEl.innerHTML = 'This app needs you to log in, which can’t work inside a preview. <strong>Open it in a new tab</strong> to use it.';
      }
    }

    function loadInPane(meta, card) {
      current = meta;
      restoreEmpty();
      btnNewTab.hidden = false;
      if (btnAbout) btnAbout.hidden = !meta.aboutUrl;
      btnClose.hidden = false;
      setTitle(meta.name, meta.url);
      activate(card);
      setUrlParam(meta.id);

      if (meta.requiresAuth) {
        showAuthRequired(meta);
        return;
      }

      pane.classList.add('is-loading');
      frame.hidden = false;
      empty.hidden = true;
      if (modeBar) modeBar.hidden = false;

      var token = ++loadToken;
      fetch(meta.url, { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit' })
        .then(function () {
          if (token !== loadToken) return;
          frame.src = meta.url;
          if (loadTimeout) clearTimeout(loadTimeout);
          loadTimeout = setTimeout(function () { showLoadError(meta); }, 10000);
          frame.addEventListener('load', function once() {
            pane.classList.remove('is-loading');
            frame.removeEventListener('load', once);
            if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
          });
        })
        .catch(function () {
          if (token !== loadToken) return;
          showLoadError(meta);
        });
    }

    function clearPane() {
      current = null;
      loadToken++;
      if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
      frame.removeAttribute('src');
      frame.hidden = true;
      frame.classList.remove('preview-tablet', 'preview-mobile');
      empty.hidden = false;
      restoreEmpty();
      btnNewTab.hidden = true;
      if (btnAbout) btnAbout.hidden = true;
      btnClose.hidden = true;
      if (modeBar) modeBar.hidden = true;
      setTitle(null, '');
      activate(null);
      pane.classList.remove('is-loading');
      setUrlParam(null);
    }

    function cardMeta(card) {
      var cta = card.querySelector('.app-cta');
      var name = card.querySelector('.app-name');
      // .app-name may contain a quality-badge child — only the first text node is the name.
      var nameText = 'App';
      if (name) {
        var n = name.firstChild;
        while (n && n.nodeType !== Node.TEXT_NODE) n = n.nextSibling;
        nameText = (n && n.textContent.trim()) || name.textContent.trim();
      }
      return {
        id: card.dataset.id || '',
        name: nameText,
        url: cta ? cta.getAttribute('href') : null,
        aboutUrl: card.dataset.about || null,
        requiresAuth: card.dataset.requiresAuth === '1',
      };
    }

    document.querySelectorAll('#apps-grid .app-card.compact').forEach(function (card) {
      var aboutUrl = card.dataset.about;
      card.style.cursor = 'pointer';
      card.addEventListener('click', function (e) {
        var onCta = !!e.target.closest('.app-cta');
        if (SPLIT_MQ.matches) {
          e.preventDefault();
          loadInPane(cardMeta(card), card);
          return;
        }
        // Single-column: card body → about, CTA → app URL via default <a target="_blank">
        if (!onCta && aboutUrl) window.location.href = aboutUrl;
      });
    });

    if (btnNewTab) btnNewTab.addEventListener('click', function () {
      if (current && current.url) window.open(current.url, '_blank', 'noopener');
    });
    if (btnAbout) btnAbout.addEventListener('click', function () {
      if (current && current.aboutUrl) window.location.href = current.aboutUrl;
    });
    if (btnClose) btnClose.addEventListener('click', clearPane);

    // Preview mode: desktop / tablet / mobile
    if (modeBar) {
      modeBar.addEventListener('click', function (e) {
        var btn = e.target.closest('.preview-mode-btn');
        if (!btn) return;
        modeBar.querySelectorAll('.preview-mode-btn').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        var mode = btn.dataset.preview;
        frame.classList.remove('preview-tablet', 'preview-mobile');
        if (mode === 'tablet') frame.classList.add('preview-tablet');
        else if (mode === 'mobile') frame.classList.add('preview-mobile');
      });
    }

    // Deep link: ?app=<id>
    try {
      var wantId = new URLSearchParams(window.location.search).get('app');
      if (wantId && SPLIT_MQ.matches) {
        var match = document.querySelector('#apps-grid .app-card.compact[data-id="' + CSS.escape(wantId) + '"]');
        if (match) loadInPane(cardMeta(match), match);
      }
    } catch (e) {}

    // Viewport shrinks below split breakpoint → clear active state.
    if (SPLIT_MQ.addEventListener) {
      SPLIT_MQ.addEventListener('change', function (e) {
        if (!e.matches) activate(null);
      });
    }
  })();
})();

// /ideas — filter, sort and search the server-rendered idea cards, and copy a
// card's build prompt. No data of its own: everything is read from the
// data-* attributes build.js writes on each card. Filter state lives in the
// URL (?status=&category=&sort=&q=) so a filtered view can be shared.
(function () {
  'use strict';

  var grid = document.getElementById('ideasGrid');
  if (!grid) return;
  var cards = Array.prototype.slice.call(grid.querySelectorAll('.ideas-card'));
  var statusBar = document.getElementById('ideasStatus');
  var categoryBar = document.getElementById('ideasCategory');
  var sortSelect = document.getElementById('ideasSort');
  var searchInput = document.getElementById('ideasSearch');
  var countEl = document.getElementById('ideasCount');
  var emptyEl = document.getElementById('ideasEmpty');

  // Status filters differ per store, so the groups come from the buttons:
  // data-statuses lists the card statuses a button shows (empty = all).
  var STATUS_GROUPS = {};
  Array.prototype.forEach.call(statusBar.querySelectorAll('.filter-btn'), function (btn) {
    var s = btn.getAttribute('data-statuses');
    STATUS_GROUPS[btn.getAttribute('data-status')] = s ? s.split(' ') : null;
  });
  var defaultStatus = statusBar.querySelector('.filter-btn').getAttribute('data-status');
  var params = new URLSearchParams(location.search);
  var state = {
    status: STATUS_GROUPS.hasOwnProperty(params.get('status')) ? params.get('status') : defaultStatus,
    category: params.get('category') || 'all',
    sort: params.get('sort') || 'priority',
    q: params.get('q') || '',
  };

  function num(card, key) { return Number(card.dataset[key]) || 0; }
  function name(card) { return card.querySelector('h3').textContent; }

  var SORTS = {
    // Ideas only this store can build first, then open ones, then the research
    // priority (decision, wave), then demand.
    priority: function (a, b) {
      return num(b, 'exclusive') - num(a, 'exclusive')
        || (a.dataset.status === 'open' ? 0 : 1) - (b.dataset.status === 'open' ? 0 : 1)
        || num(a, 'decision') - num(b, 'decision')
        || num(a, 'wave') - num(b, 'wave')
        || num(b, 'demand') - num(a, 'demand');
    },
    demand: function (a, b) { return num(b, 'demand') - num(a, 'demand') || num(a, 'difficulty') - num(b, 'difficulty'); },
    easy: function (a, b) { return num(a, 'difficulty') - num(b, 'difficulty') || num(b, 'demand') - num(a, 'demand'); },
    az: function (a, b) { return name(a).localeCompare(name(b)); },
  };
  if (!SORTS[state.sort]) state.sort = 'priority';

  function setPressed(bar, attr, value) {
    Array.prototype.forEach.call(bar.querySelectorAll('.filter-btn'), function (btn) {
      var on = btn.getAttribute(attr) === value;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function syncUrl() {
    var p = new URLSearchParams();
    if (state.status !== defaultStatus) p.set('status', state.status);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.sort !== 'priority') p.set('sort', state.sort);
    if (state.q) p.set('q', state.q);
    var qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  function render() {
    var allowed = STATUS_GROUPS[state.status];
    var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0;
    cards.sort(SORTS[state.sort]).forEach(function (card) {
      var visible = (!allowed || allowed.indexOf(card.dataset.status) !== -1)
        && (state.category === 'all' || card.dataset.category === state.category)
        && terms.every(function (t) { return card.dataset.search.indexOf(t) !== -1; });
      card.hidden = !visible;
      if (visible) shown++;
      grid.appendChild(card);
    });
    countEl.textContent = shown + (shown === 1 ? ' idea' : ' ideas');
    emptyEl.hidden = shown !== 0;
    setPressed(statusBar, 'data-status', state.status);
    setPressed(categoryBar, 'data-category', state.category);
    sortSelect.value = state.sort;
    syncUrl();
  }

  statusBar.addEventListener('click', function (e) {
    var btn = e.target.closest('.filter-btn');
    if (!btn) return;
    state.status = btn.getAttribute('data-status');
    render();
  });
  categoryBar.addEventListener('click', function (e) {
    var btn = e.target.closest('.filter-btn');
    if (!btn) return;
    state.category = btn.getAttribute('data-category');
    render();
  });
  sortSelect.addEventListener('change', function () {
    state.sort = sortSelect.value;
    render();
  });
  searchInput.value = state.q;
  searchInput.addEventListener('input', function () {
    state.q = searchInput.value.trim();
    render();
  });

  grid.addEventListener('click', function (e) {
    var btn = e.target.closest('.ideas-copy');
    if (!btn) return;
    var label = btn.textContent;
    function done(msg) {
      btn.textContent = msg;
      setTimeout(function () { btn.textContent = label; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(btn.getAttribute('data-prompt')).then(
        function () { done('Copied'); },
        function () { done('Copy failed'); }
      );
    } else {
      done('Copy not supported');
    }
  });

  // A deep link to one card (#idea-<id>) should show it even when the
  // default filter would hide it.
  var target = location.hash && document.getElementById(location.hash.slice(1));
  if (target && target.classList.contains('ideas-card') && !params.has('status')) {
    var group = Object.keys(STATUS_GROUPS).filter(function (k) {
      return STATUS_GROUPS[k] && STATUS_GROUPS[k].indexOf(target.dataset.status) !== -1;
    })[0];
    state.status = group || 'all';
  }

  render();
  if (target) target.scrollIntoView();
})();

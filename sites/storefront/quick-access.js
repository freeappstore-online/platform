/* Local shortcuts (#862). Store IDs only; URLs always come from the published catalogue. */
(function (root) {
  'use strict';
  var KEY = 'fas:quick-access:v1';
  var valid = function (id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(id); };
  function ids(value, limit) {
    return Array.isArray(value) ? Array.from(new Set(value.filter(valid))).slice(0, limit) : [];
  }
  function createStore(storage) {
    var state = { favourites: [], recent: [] }, persistent = true;
    function reload() {
      try {
        var raw = storage.getItem(KEY);
        var parsed = raw && raw.length <= 32000 ? JSON.parse(raw) : {};
        state = { favourites: ids(parsed && parsed.favourites, 200), recent: ids(parsed && parsed.recent, 12) };
      } catch (_) { /* Unavailable or damaged storage must not stop browsing. */ }
    }
    function save() {
      try { storage.setItem(KEY, JSON.stringify(state)); persistent = true; }
      catch (_) { persistent = false; }
    }
    reload();
    return {
      snapshot: function () { return { favourites: state.favourites.slice(), recent: state.recent.slice(), persistent: persistent }; },
      reload: reload,
      toggle: function (id) {
        if (!valid(id)) return;
        if (persistent) reload();
        state.favourites = state.favourites.includes(id) ? state.favourites.filter(function (v) { return v !== id; }) : ids(state.favourites.concat(id), 200);
        save();
      },
      opened: function (id) {
        if (!valid(id)) return;
        if (persistent) reload();
        state.recent = ids([id].concat(state.recent), 12); save();
      },
      clearRecent: function () { if (persistent) reload(); state.recent = []; save(); },
    };
  }
  root.FasShortcuts = { createStore: createStore };
  if (!root.document) return;
  var document = root.document;
  var storage = { getItem: function (key) { return root.localStorage.getItem(key); }, setItem: function (key, value) { root.localStorage.setItem(key, value); } };
  var store = createStore(storage), apps = new Map(), controls = [];
  var section = document.getElementById('quick-access');
  function appData(element) {
    var id = element.dataset.id, name = element.dataset.name;
    var link = element.querySelector('a.app-cta');
    if (!valid(id) || !name || !link) return null;
    try {
      var url = new URL(link.getAttribute('href'));
      if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.freeappstore\.online$/.test(url.hostname) || url.username || url.password || url.port) return null;
      var icon = element.querySelector('.app-emoji');
      return { id: id, name: name, url: url.href, icon: icon ? icon.textContent.trim() : name.charAt(0) };
    } catch (_) { return null; }
  }
  function make(tag, text, className) {
    var el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function star(app) {
    var button = make('button', '', 'shortcut-star');
    button.type = 'button'; button.dataset.favouriteId = app.id;
    controls.push({ button: button, app: app });
    return button;
  }
  document.querySelectorAll('.app-card[data-id], [data-quick-app]').forEach(function (el) {
    var app = appData(el);
    if (!app) return;
    apps.set(app.id, app);
    var host = el.querySelector('.app-body') || el.querySelector('.preview-actions');
    if (host) host.appendChild(star(app));
  });
  var staticControls = controls.slice();
  function render() {
    var state = store.snapshot();
    controls = staticControls.slice();
    if (section) {
      section.replaceChildren();
      section.appendChild(make('h2', 'Quick access'));
      var note = make('p', state.persistent ? 'Your favourites and recently opened apps stay in this browser.' : 'Browser storage is unavailable. Shortcuts are kept only until this page closes.', 'meta');
      note.setAttribute('role', 'status'); section.appendChild(note);
      var favourites = state.favourites.map(function (id) { return apps.get(id); }).filter(Boolean);
      var recent = state.recent.filter(function (id) { return !state.favourites.includes(id); }).map(function (id) { return apps.get(id); }).filter(Boolean).slice(0, 6);
      function group(title, items) {
        if (!items.length) return;
        section.appendChild(make('h3', title));
        var list = make('ul', '', 'shortcut-grid');
        items.forEach(function (app) {
          var item = make('li', '', 'shortcut-item');
          var link = make('a', '', 'shortcut-open');
          link.href = app.url; link.target = '_blank'; link.rel = 'noopener'; link.dataset.openApp = app.id;
          link.setAttribute('aria-label', 'Open ' + app.name);
          var icon = make('span', app.icon, 'shortcut-icon'); icon.setAttribute('aria-hidden', 'true');
          link.appendChild(icon); link.appendChild(make('span', app.name));
          item.appendChild(link); item.appendChild(star(app)); list.appendChild(item);
        });
        section.appendChild(list);
      }
      group('Favourites', favourites); group('Recently used', recent);
      if (!favourites.length && !recent.length) section.appendChild(make('p', 'Star an app to keep it here. Apps you open appear here automatically.'));
      if (state.recent.length) {
        var clear = make('button', 'Clear recently used', 'app-btn-secondary'); clear.type = 'button';
        clear.addEventListener('click', function () { store.clearRecent(); render(); }); section.appendChild(clear);
      }
    }
    controls.forEach(function (control) {
      var on = state.favourites.includes(control.app.id);
      control.button.textContent = on ? '★' : '☆';
      control.button.setAttribute('aria-pressed', String(on));
      control.button.setAttribute('aria-label', (on ? 'Unfavourite ' : 'Favourite ') + control.app.name);
      control.button.title = (on ? 'Remove from' : 'Add to') + ' favourites';
    });
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (event) {
    document.addEventListener(event, function (e) { if (e.target.closest && e.target.closest('[data-favourite-id]')) e.stopPropagation(); }, true);
  });
  document.addEventListener('click', function (e) {
    var target = e.target.closest && e.target.closest('[data-favourite-id]');
    if (target) {
      e.preventDefault(); e.stopPropagation();
      var id = target.dataset.favouriteId;
      if (apps.has(id)) {
        store.toggle(id); render();
        // A shortcut may move between lists after toggling. Keep keyboard focus on its control.
        if (target.isConnected) target.focus({ preventScroll: true });
        else {
          var next = controls.find(function (c) { return c.app.id === id && section && section.contains(c.button); }) || controls.find(function (c) { return c.app.id === id; });
          if (next) next.button.focus({ preventScroll: true });
        }
      }
      return;
    }
    var link = e.target.closest && e.target.closest('a');
    if (!link) return;
    var app = Array.from(apps.values()).find(function (a) { return a.url === link.href; });
    if (app) {
      store.opened(app.id);
      // Keep the clicked link in the document until its default navigation has happened.
      root.setTimeout(render, 0);
    }
  }, true);
  root.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) { store.reload(); render(); } });
  render();
})(typeof window === 'object' ? window : globalThis);

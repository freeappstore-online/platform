// /ideas — "I'm building this" on each card, so two creators don't pick the
// same idea without knowing. Counts come from the FAS API; the caller's own
// claims need the storefront session auth.js keeps in localStorage. If the API
// is unreachable the claim slots stay hidden and the page works as before.
(function () {
  'use strict';

  var API = 'https://api.freeappstore.online';
  var slots = Array.prototype.slice.call(document.querySelectorAll('.ideas-claim[data-idea]'));
  if (!slots.length || !window.fetch) return;

  function token() {
    try {
      var s = JSON.parse(localStorage.getItem('fas:session') || 'null');
      return s && typeof s.token === 'string' ? s.token : null;
    } catch (e) { return null; }
  }
  function headers() {
    var t = token();
    return t ? { Authorization: 'Bearer ' + t } : {};
  }
  function signIn(ideaId) {
    var back = location.origin + location.pathname + '#idea-' + ideaId;
    var url = new URL('/v1/auth/github/start', API);
    url.searchParams.set('app_id', 'store');
    url.searchParams.set('return_to', back);
    location.href = url.toString();
  }
  function countText(n) {
    if (!n) return '';
    return n === 1 ? '1 person building this' : n + ' people building this';
  }

  function render(slot, count, mine) {
    var label = slot.querySelector('.ideas-claim-count');
    var btn = slot.querySelector('.ideas-claim-btn');
    if (!btn) {
      label = document.createElement('span');
      label.className = 'ideas-claim-count';
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ideas-claim-btn';
      slot.appendChild(btn);
      slot.appendChild(label);
    }
    label.textContent = countText(count);
    btn.textContent = mine ? 'You’re building this ✓' : 'I’m building this';
    btn.setAttribute('aria-pressed', mine ? 'true' : 'false');
    btn.title = mine ? 'Click to drop your claim' : 'Let others know you are building this idea';
    slot.hidden = false;
  }

  function load(auth) {
    return fetch(API + '/v1/store/idea-builders', { headers: auth ? headers() : {} })
      .then(function (r) {
        if (r.status === 401 && auth) return load(false); // stale session: show counts anyway
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  load(!!token()).then(function (data) {
    var builders = (data && data.builders) || {};
    var mine = (data && data.mine) || {};
    slots.forEach(function (slot) {
      var id = slot.getAttribute('data-idea');
      render(slot, builders[id] || 0, !!mine[id]);
    });
  }).catch(function () { /* keep the slots hidden */ });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.ideas-claim-btn');
    if (!btn || btn.disabled) return;
    var slot = btn.parentNode;
    var id = slot.getAttribute('data-idea');
    if (!token()) { signIn(id); return; }
    var claiming = btn.getAttribute('aria-pressed') !== 'true';
    btn.disabled = true;
    fetch(API + '/v1/store/ideas/' + encodeURIComponent(id) + '/builder', {
      method: claiming ? 'POST' : 'DELETE',
      headers: headers(),
    }).then(function (r) {
      if (r.status === 401) { signIn(id); return null; }
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || 'Something went wrong');
        return body;
      });
    }).then(function (body) {
      btn.disabled = false;
      if (body) render(slot, body.count, body.building);
    }).catch(function (err) {
      btn.disabled = false;
      var was = btn.textContent;
      btn.textContent = err.message;
      setTimeout(function () { btn.textContent = was; }, 3000);
    });
  });
})();

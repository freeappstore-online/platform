/**
 * FreeAppStore per-app detail page — interactive layer.
 *
 * Loaded by templates/app-detail.html. Reads the app's id from a JSON island
 * (<script type="application/json" id="page-data">) so the page can be a
 * pure static document with no inline JS — CSP stays locked (script-src
 * 'self' + the theme-bootstrap hash, no 'unsafe-inline').
 */
(function () {
  // ── Page data from JSON island ──
  var APP_ID = "";
  try {
    var raw = document.getElementById("page-data")?.textContent;
    if (raw) APP_ID = (JSON.parse(raw) || {}).id || "";
  } catch (e) {}
  if (!APP_ID) return;

  // ── Reload-preview button (refreshes the embedded app iframe) ──
  document.querySelectorAll('[data-action="reload-preview"]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      var iframe = document.querySelector(".phone-frame iframe");
      if (!iframe) return;
      var url = new URL(iframe.src);
      url.searchParams.set("_r", Date.now().toString(36));
      iframe.src = url.toString();
    });
  });

  // ── Local-only thumbs up / down ratings ──
  // (Persisted in localStorage until a backend endpoint exists.)
  var KEY = "fas_voted_" + APP_ID;
  var upBtn = document.getElementById("rate-up");
  var downBtn = document.getElementById("rate-down");
  var countUp = document.getElementById("count-up");
  var countDown = document.getElementById("count-down");
  var statusEl = document.getElementById("rating-status");
  if (!upBtn || !downBtn || !countUp || !countDown || !statusEl) return;

  var stored;
  try {
    stored = JSON.parse(localStorage.getItem("fas_ratings_" + APP_ID) || '{"up":0,"down":0}');
  } catch (e) {
    stored = { up: 0, down: 0 };
  }
  countUp.textContent = stored.up;
  countDown.textContent = stored.down;

  var voted = null;
  try { voted = localStorage.getItem(KEY); } catch (e) {}
  if (voted) {
    statusEl.textContent = "You voted " + (voted === "up" ? "👍" : "👎");
    upBtn.disabled = true;
    downBtn.disabled = true;
    upBtn.style.opacity = voted === "up" ? "1" : "0.4";
    downBtn.style.opacity = voted === "down" ? "1" : "0.4";
  }

  function vote(dir) {
    try { if (localStorage.getItem(KEY)) return; } catch (e) {}
    try { localStorage.setItem(KEY, dir); } catch (e) {}
    statusEl.textContent = "Thanks!";
    upBtn.disabled = true;
    downBtn.disabled = true;
    upBtn.style.opacity = dir === "up" ? "1" : "0.4";
    downBtn.style.opacity = dir === "down" ? "1" : "0.4";
    var el = dir === "up" ? countUp : countDown;
    el.textContent = parseInt(el.textContent, 10) + 1;
    var r;
    try { r = JSON.parse(localStorage.getItem("fas_ratings_" + APP_ID) || '{"up":0,"down":0}'); }
    catch (e) { r = { up: 0, down: 0 }; }
    r[dir]++;
    try { localStorage.setItem("fas_ratings_" + APP_ID, JSON.stringify(r)); } catch (e) {}
  }

  upBtn.addEventListener("click", function () { vote("up"); });
  downBtn.addEventListener("click", function () { vote("down"); });
})();

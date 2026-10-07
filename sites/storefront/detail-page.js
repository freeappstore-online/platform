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

  // ── Platform vote ──
  // This mirrors the authenticated card vote behaviour on the storefront.
  var API = "https://api.freeappstore.online";
  var voteBtn = document.getElementById("rate-vote");
  var countEl = document.getElementById("vote-count");
  var statusEl = document.getElementById("rating-status");
  if (!voteBtn || !countEl || !statusEl) return;

  var count = null;
  var voted = false;

  function token() {
    try {
      var session = JSON.parse(localStorage.getItem("fas:session") || "null");
      return session && typeof session.token === "string" ? session.token : null;
    } catch (e) { return null; }
  }

  function triggerSignIn() {
    var url = new URL("/v1/auth/github/start", API);
    url.searchParams.set("app_id", "store");
    url.searchParams.set("return_to", window.location.href);
    window.location.href = url.toString();
  }

  function setVoteState(nextVoted, nextCount) {
    voted = !!nextVoted;
    count = typeof nextCount === "number" ? nextCount : null;
    countEl.textContent = count === null ? "Unavailable" : String(count);
    voteBtn.setAttribute("aria-pressed", voted ? "true" : "false");
    voteBtn.classList.toggle("voted", voted);
  }

  fetch(API + "/v1/store/votes")
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      if (!data || !data.votes || typeof data.votes !== "object") return Promise.reject("invalid vote response");
      setVoteState(false, typeof data.votes[APP_ID] === "number" ? data.votes[APP_ID] : 0);
      voteBtn.disabled = false;
      statusEl.textContent = "";
    })
    .catch(function () {
      setVoteState(false, null);
      voteBtn.disabled = false;
      statusEl.textContent = "Vote count unavailable. You can still vote.";
    });

  voteBtn.addEventListener("click", function () {
    var authToken = token();
    if (!authToken) return triggerSignIn();

    var previousVoted = voted;
    var previousCount = count;
    var nextVoted = !previousVoted;
    var optimisticCount = previousCount === null ? null : Math.max(0, previousCount + (nextVoted ? 1 : -1));
    setVoteState(nextVoted, optimisticCount);
    voteBtn.disabled = true;
    statusEl.textContent = "Saving vote…";

    fetch(API + "/v1/store/apps/" + encodeURIComponent(APP_ID) + "/vote", {
      method: nextVoted ? "POST" : "DELETE",
      headers: { Authorization: "Bearer " + authToken }
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        setVoteState(!!data.voted, typeof data.count === "number" ? data.count : optimisticCount);
        statusEl.textContent = data.voted ? "Vote recorded." : "Vote removed.";
      })
      .catch(function () {
        setVoteState(previousVoted, previousCount);
        statusEl.textContent = "Could not save your vote. Please try again.";
      })
      .finally(function () { voteBtn.disabled = false; });
  });
})();

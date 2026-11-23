/** Shared auth + mobile nav + theme toggle: runs on every page.
 *  - Applies stored or system theme (storefront also applies it inline in <head>
 *    to avoid flash; this handles non-storefront pages that lack the preload).
 *  - Injects a moon/sun theme-toggle button into the header on pages that
 *    don't already have one (the storefront ships it in the template).
 *  - Adds one profile button (avatar, or a person icon when signed out) to
 *    <span id="navAuth">; both open /profile.
 *  - Renders the Account section of /profile (#profileAccount).
 *  - Adds hamburger menu button + overlay for mobile nav. */

(function () {
  var API = "https://api.freeappstore.online";

  // The value this browser sends at sign-in start; the API echoes it with the
  // session so a crafted link can't silently plant another account (#564).
  var CLIENT_STATE_KEY = "fas:auth-state";
  function clientState() {
    try {
      var value = localStorage.getItem(CLIENT_STATE_KEY);
      if (!value) {
        var bytes = crypto.getRandomValues(new Uint8Array(24));
        value = Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
        localStorage.setItem(CLIENT_STATE_KEY, value);
      }
      return value;
    } catch (e) { return null; }
  }
  function claimClientState(state) {
    try {
      if (!state || localStorage.getItem(CLIENT_STATE_KEY) !== state) return false;
      localStorage.removeItem(CLIENT_STATE_KEY);
      return true;
    } catch (e) { return false; }
  }

  // ── Icon fallback (runs on every page that has .app-icon elements) ──
  // If an apple-touch-icon fails to load, swap the <img> for a text node
  // containing the first letter (stored on the parent as data-letter).
  function bindIconFallback(img) {
    function fallback() {
      var letter = (img.parentElement && img.parentElement.dataset.letter) || '?';
      img.replaceWith(document.createTextNode(letter));
    }
    if (img.complete && img.naturalHeight === 0) fallback();
    else img.addEventListener("error", fallback, { once: true });
  }
  document.querySelectorAll(".app-icon img").forEach(bindIconFallback);

  // ── Theme: apply stored / preferred mode ──
  try {
    var stored = localStorage.getItem("stores-theme");
    var preferDark = stored === "dark" || (!stored || stored === "system") && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (preferDark) document.documentElement.dataset.theme = "dark";
  } catch (e) {}

  // ── Account button slot (inject on pages without a pre-built header-right) ──
  if (!document.querySelector('.header-right')) {
    var headerC = document.querySelector('header .container');
    if (headerC) {
      var hr = document.createElement('div');
      hr.className = 'header-right';
      var navAuth = document.createElement('span');
      navAuth.id = 'navAuth';
      hr.appendChild(navAuth);
      headerC.appendChild(hr);
    }
  }

  // ── Mobile hamburger menu ──
  var nav = document.querySelector("header nav");
  var headerContainer = document.querySelector("header .container");
  if (nav && headerContainer) {
    var btn = document.createElement("button");
    btn.className = "nav-toggle";
    btn.setAttribute("aria-label", "Menu");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "☰";
    headerContainer.appendChild(btn);

    var overlay = document.createElement("div");
    overlay.className = "nav-overlay";
    overlay.setAttribute("aria-hidden", "true");
    document.body.appendChild(overlay);

    var closeBtn = document.createElement("button");
    closeBtn.className = "nav-close";
    closeBtn.setAttribute("aria-label", "Close menu");
    closeBtn.textContent = "×";
    nav.insertBefore(closeBtn, nav.firstChild);
    if (!nav.id) nav.id = "mobile-navigation";
    btn.setAttribute("aria-controls", nav.id);

    var lastFocused = null;
    function isOpen() { return nav.classList.contains("open"); }
    function focusableItems() {
      return Array.prototype.slice.call(nav.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    }
    function openMenu() {
      lastFocused = document.activeElement;
      nav.classList.add("open");
      overlay.classList.add("open");
      nav.setAttribute("aria-hidden", "false");
      btn.setAttribute("aria-expanded", "true");
      var first = focusableItems()[0];
      if (first && typeof first.focus === "function") first.focus();
    }
    function closeMenu(restoreFocus) {
      if (!isOpen()) return;
      nav.classList.remove("open");
      overlay.classList.remove("open");
      nav.setAttribute("aria-hidden", "true");
      btn.setAttribute("aria-expanded", "false");
      if (restoreFocus !== false && lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    }

    btn.addEventListener("click", openMenu);
    closeBtn.addEventListener("click", closeMenu);
    overlay.addEventListener("click", closeMenu);
    nav.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { closeMenu(false); }); });
    document.addEventListener("keydown", function (e) {
      if (!isOpen()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        return;
      }
      if (e.key !== "Tab") return;
      var items = focusableItems();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // ── Auth avatar ──
  var el = document.getElementById("navAuth");
  if (!el) return;
  var account = document.getElementById("profileAccount");

  // Check localStorage for cached session (same key as @freeappstore/sdk)
  var session = null;
  try {
    var raw = localStorage.getItem("fas:session");
    if (raw) session = JSON.parse(raw);
  } catch (e) {}

  // Tokens are opaque to us but must be safe to splice into an
  // Authorization header. Spec-modern fetch rejects CR/LF in header values,
  // but a charset+length check at the source defends against future browsers
  // / non-browser callers and keeps the trust boundary tight.
  function isPlausibleToken(t) {
    return typeof t === "string"
      && t.length > 0
      && t.length <= 1024
      && /^[A-Za-z0-9._~+/=:-]+$/.test(t);
  }

  function notifyAuthReady() {
    if (typeof window.dispatchEvent !== "function") return;
    // Event is available in supported browsers. The object fallback keeps the
    // shared script harmless in lightweight embedded test environments.
    var event = typeof Event === "function" ? new Event("fas:auth-ready") : { type: "fas:auth-ready" };
    window.dispatchEvent(event);
  }

  if (session && session.token && session.user && isPlausibleToken(session.token)) {
    showUser(session.user);
    // Verify session is still valid in background. On 401/403 we clear the
    // session and replace the avatar with Sign In — no location.reload(),
    // which used to loop on permanently-revoked sessions.
    fetch(API + "/v1/auth/me", { headers: { Authorization: "Bearer " + session.token } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          try { localStorage.removeItem("fas:session"); } catch (e) {}
          el.replaceChildren();
          showSignIn();
        } else if (r.ok) {
          notifyAuthReady();
        }
      })
      .catch(function () {});
  } else {
    // Check for OAuth callback hash
    var hash = window.location.hash;
    if (hash.indexOf("#fas_session=") === 0) {
      var token = "";
      var parts = hash.slice("#fas_session=".length).split("&fas_state=");
      try { token = decodeURIComponent(parts[0]); } catch (e) {}
      var startedHere = claimClientState(parts[1]);
      // Always strip the hash so a malformed token doesn't linger in the URL.
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (isPlausibleToken(token)) {
        fetch(API + "/v1/auth/me", { headers: { Authorization: "Bearer " + token } })
          .then(function (r) {
            if (!r.ok) throw new Error("Invalid session");
            return r.json();
          })
          .then(function (user) {
            // A session this browser did not ask for may be someone else's account (#564).
            if (user && user.id && !startedHere && !window.confirm("Sign in as " + user.login + "?")) {
              showSignIn();
              return;
            }
            if (user && user.id) {
              try { localStorage.setItem("fas:session", JSON.stringify({ token: token, user: user })); } catch (e) {}
              showUser(user);
              notifyAuthReady();
            } else {
              showSignIn();
            }
          })
          .catch(function () { showSignIn(); });
        return;
      }
    }
    showSignIn();
  }

  function startSignIn(e) {
    if (e) e.preventDefault();
    var url = new URL("/v1/auth/github/start", API);
    url.searchParams.set("app_id", "store");
    url.searchParams.set("return_to", window.location.href);
    var state = clientState();
    if (state) url.searchParams.set("client_state", state);
    window.location.href = url.toString();
  }

  function showUser(user) {
    var a = document.createElement("a");
    a.href = "/profile";
    a.className = "nav-profile";
    a.title = user.login || "Profile";
    a.setAttribute("aria-label", "Profile");
    if (user.avatarUrl) {
      var img = document.createElement("img");
      img.className = "nav-avatar";
      img.src = user.avatarUrl;
      img.alt = "";
      a.appendChild(img);
    } else {
      a.textContent = (user.login || "?").charAt(0).toUpperCase();
    }
    el.appendChild(a);
    if (account) showAccountUser(user);
  }

  function showSignIn() {
    var link = document.createElement("a");
    link.href = "/profile";
    link.className = "nav-profile";
    link.title = "Sign in";
    link.setAttribute("aria-label", "Sign in");
    link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
    el.appendChild(link);
    if (account) showAccountSignIn();
  }

  function showAccountUser(user) {
    var row = document.createElement("div");
    row.className = "profile-user";
    if (user.avatarUrl) {
      var img = document.createElement("img");
      img.className = "profile-avatar";
      img.src = user.avatarUrl;
      img.alt = "";
      row.appendChild(img);
    }
    var name = document.createElement("strong");
    name.textContent = user.login || "Signed in";
    row.appendChild(name);
    var actions = document.createElement("div");
    actions.className = "profile-actions";
    var consoleLink = document.createElement("a");
    consoleLink.className = "btn-primary";
    consoleLink.href = "/app/";
    consoleLink.textContent = "Creator Console";
    var signOut = document.createElement("button");
    signOut.type = "button";
    signOut.className = "setting-option";
    signOut.textContent = "Sign out";
    signOut.addEventListener("click", function () {
      try { localStorage.removeItem("fas:session"); } catch (e) {}
      el.replaceChildren();
      account.replaceChildren();
      showSignIn();
    });
    actions.appendChild(consoleLink);
    actions.appendChild(signOut);
    account.replaceChildren(row, actions);
  }

  function showAccountSignIn() {
    var desc = document.createElement("p");
    desc.className = "setting-desc";
    desc.textContent = "Sign in to like apps and use the Creator Console.";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary";
    btn.textContent = "Sign in with GitHub";
    btn.addEventListener("click", startSignIn);
    account.replaceChildren(desc, btn);
  }
})();

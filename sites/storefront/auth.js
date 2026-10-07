/** Shared auth + mobile nav + theme toggle: runs on every page.
 *  - Applies stored or system theme (storefront also applies it inline in <head>
 *    to avoid flash; this handles non-storefront pages that lack the preload).
 *  - Injects a moon/sun theme-toggle button into the header on pages that
 *    don't already have one (the storefront ships it in the template).
 *  - Adds avatar or sign-in link to <span id="navAuth">.
 *  - Adds hamburger menu button + overlay for mobile nav. */

(function () {
  var API = "https://api.freeappstore.online";

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

  // ── Settings link (inject on pages without a pre-built header-right) ──
  if (!document.querySelector('.header-right')) {
    var headerC = document.querySelector('header .container');
    if (headerC) {
      var hr = document.createElement('div');
      hr.className = 'header-right';
      var sl = document.createElement('a');
      sl.href = '/settings';
      sl.className = 'settings-link';
      sl.setAttribute('aria-label', 'Settings');
      sl.title = 'Settings';
      sl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
      var navAuth = document.createElement('span');
      navAuth.id = 'navAuth';
      hr.appendChild(sl);
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
      try { token = decodeURIComponent(hash.slice("#fas_session=".length)); } catch (e) {}
      // Always strip the hash so a malformed token doesn't linger in the URL.
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (isPlausibleToken(token)) {
        fetch(API + "/v1/auth/me", { headers: { Authorization: "Bearer " + token } })
          .then(function (r) {
            if (!r.ok) throw new Error("Invalid session");
            return r.json();
          })
          .then(function (user) {
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

  function showUser(user) {
    var a = document.createElement("a");
    a.href = "https://freeappstore.online/app/";
    a.title = user.login || "Profile";
    if (user.avatarUrl) {
      var img = document.createElement("img");
      img.className = "nav-avatar";
      img.src = user.avatarUrl;
      img.alt = user.login || "";
      a.appendChild(img);
    } else {
      a.textContent = user.login || "Profile";
      a.className = "nav-signin";
    }
    el.appendChild(a);
  }

  function showSignIn() {
    var link = document.createElement("a");
    link.className = "nav-signin";
    link.textContent = "Sign in";
    link.href = "#";
    link.onclick = function (e) {
      e.preventDefault();
      var url = new URL("/v1/auth/github/start", API);
      url.searchParams.set("app_id", "store");
      url.searchParams.set("return_to", window.location.href);
      window.location.href = url.toString();
    };
    el.appendChild(link);
  }
})();

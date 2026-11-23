/**
 * Near-one-tap install for the Android companion (#621, the FAS port of
 * proappstore-online/platform#628 part A). The companion opens an app at
 * `/?install=1`; only then does the HTML carry a same-origin script that shows
 * an Install bar wired to the deferred `beforeinstallprompt`. Same-origin
 * because an app's own meta CSP may pin `script-src 'self'`.
 */
import { type SecurityPolicy, securityHeaders } from "./host";

export const INSTALL_SCRIPT_PATH = "/.fas/install.js";
export const INSTALL_SCRIPT_TAG = `<script src="${INSTALL_SCRIPT_PATH}" defer></script>`;

/** True only for the exact `install=1` query parameter the companion sends. */
export function wantsInstall(url: URL): boolean {
  return url.searchParams.get("install") === "1";
}

// Plain ES2019, no dependencies, no network except the same-origin manifest.
// The bar lives in a closed shadow root, so app CSS cannot break it and it
// cannot break the app; it inherits the SDK's design tokens with fallbacks.
// No timeout fallback: when the browser never offers the prompt (criteria not
// met, already installed, Safari/Firefox), nothing shows and the app is open.
export const INSTALL_SCRIPT = `(function () {
  var u = new URL(location.href);
  if (u.searchParams.get("install") === "1") {
    u.searchParams.delete("install");
    history.replaceState(history.state, "", u.href);
  }
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) return;
  if (!("onbeforeinstallprompt" in window)) return;
  var deferred = null;
  var host = null;
  function remove() {
    if (host) host.remove();
    host = null;
  }
  function label() {
    var link = document.querySelector('link[rel="manifest"]');
    if (!link || !link.href || new URL(link.href).origin !== location.origin) return Promise.resolve("Install app");
    return fetch(link.href, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (m) {
        var name = m && (m.short_name || m.name);
        return typeof name === "string" && name.trim() ? "Install " + name.trim() : "Install app";
      })
      .catch(function () { return "Install app"; });
  }
  function show() {
    return label().then(function (text) {
      if (host || !deferred) return;
      host = document.createElement("div");
      var root = host.attachShadow({ mode: "closed" });
      root.innerHTML =
        "<style>" +
        ".bar{position:fixed;inset-inline:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483647;display:flex;gap:8px;align-items:center;padding:8px;border-radius:14px;background:var(--panel,#fff);color:var(--ink,#1e293b);border:1px solid var(--line,#e2e8f0);box-shadow:0 8px 24px rgba(15,23,42,.18);font:500 15px/1.2 system-ui,sans-serif}" +
        "button{min-height:44px;border-radius:10px;font:inherit;cursor:pointer;padding:0 16px}" +
        ".install{flex:1;border:0;background:var(--accent,#2563eb);color:#fff;font-weight:600}" +
        ".later{border:1px solid var(--line,#e2e8f0);background:transparent;color:inherit}" +
        "</style>" +
        '<div class="bar" role="dialog" aria-label="Install"><button class="install" type="button"></button><button class="later" type="button">Not now</button></div>';
      var install = root.querySelector(".install");
      install.textContent = text;
      install.addEventListener("click", function () {
        var prompt = deferred;
        deferred = null;
        if (!prompt) return remove();
        Promise.resolve()
          .then(function () { return prompt.prompt(); })
          .then(function () { return prompt.userChoice; })
          .then(remove, remove);
      });
      root.querySelector(".later").addEventListener("click", remove);
      (document.body || document.documentElement).appendChild(host);
    });
  }
  addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    show();
  }, { once: true });
  addEventListener("appinstalled", remove);
})();
`;

/** `GET|HEAD /.fas/install.js`: the same static script for every app. */
export function installScriptResponse(method: string, policy: SecurityPolicy = {}): Response {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const headers = securityHeaders({ htmlCache: true, ...policy });
  headers.set("content-type", "text/javascript; charset=utf-8");
  headers.set("cache-control", "public, max-age=3600");
  return new Response(method === "HEAD" ? null : INSTALL_SCRIPT, { headers });
}

/**
 * Put the script tag immediately before `</head>`, or at the end of a document
 * that has no `<head>` tag. The body differs from the R2 object, so it loses
 * the object's ETag and is not cached.
 */
export function injectInstallScript(response: Response): Response {
  let injected = false;
  const rewriter = new HTMLRewriter()
    .on("head", {
      element(el: Element) {
        el.onEndTag((end) => {
          if (injected) return;
          injected = true;
          end.before(INSTALL_SCRIPT_TAG, { html: true });
        });
      },
    })
    .onDocument({
      end(end) {
        if (!injected) end.append(INSTALL_SCRIPT_TAG, { html: true });
      },
    });
  const headers = new Headers(response.headers);
  headers.delete("etag");
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return rewriter.transform(new Response(response.body, { status: response.status, headers }));
}

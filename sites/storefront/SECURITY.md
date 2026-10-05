# Security Model — FreeAppStore Storefront

This document describes the security posture of the FreeAppStore storefront
(everything served from `freeappstore.online`). It's intentionally short —
the goal is "anyone touching this repo understands what's protecting what."

## Threat model

The storefront is **static HTML/CSS/JS** generated at build time from
`registry.json`. There is no server-side render, no user-supplied input
accepted at runtime by the storefront itself (the app runtime lives elsewhere).

The main risks worth thinking about:

| Risk                                    | Where                       | Mitigation                                                                                                                |
| --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Malicious registry entry                | registry.json               | Build-time validator — shape, length, control-char checks. Build fails loud on bad data. Plus HTML/URL-escape at render.  |
| Clickjacking                            | Browser embedding storefront| `X-Frame-Options: DENY` + `frame-ancestors 'none'` in `_headers`.                                                          |
| XSS via inline script / style           | Page HTML                   | Hash-based CSP (`script-src 'self' 'sha256-…'`, `style-src 'self'`). No `'unsafe-inline'` anywhere on index pages.        |
| Iframed app escapes sandbox             | Embedded app                | Sandbox attribute restricts; **first-party trust** today. See "Open questions" below.                                     |
| Session token theft via XSS             | auth.js                     | Token shape validated, length-capped. Stored in `localStorage` (real fix is HttpOnly cookies — needs API worker change).  |
| OAuth open-redirect via `return_to`     | auth.js → API               | Server-side responsibility — API validates `return_to`.                                                                   |
| Image / fetch exfiltration via CSP gap  | Any HTTPS host              | `img-src` and `connect-src` allowlisted to `*.freeappstore.online` + `api.freeappstore.online`. No blanket `https:`.      |
| Inline `style=` from registry data      | Card markup                 | Eliminated — per-card icon backgrounds live in build-emitted `dist/card-styles.css`, never inline.                        |
| Inline `onerror` JS injection           | Card markup                 | Eliminated — fallback letter lives on a `data-letter` attribute, bound by an external script.                             |

## Headers (single source of truth: `dist/_headers`)

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=(),
                    magnetometer=(), gyroscope=(), accelerometer=(), midi=()
Content-Security-Policy: <see build.js — locked-down, hash-based>
Content-Security-Policy-Report-Only: <same, for telemetry>
```

The CSP **does not** appear in `<meta http-equiv>`. Headers are the only
source of truth. Test `no <meta http-equiv=Content-Security-Policy>...`
enforces this.

## Tests that enforce these invariants

`test/build.test.mjs` runs on every PR + push to main (via `.github/workflows/test.yml`):

- Validator rejects bad `id`, `appUrl`, `iconBg`, duplicate ids, control-char strings, oversized names.
- HTML-escape applied to every user-controlled field.
- No `onerror=` survives the build.
- No inline `style=` on cards.
- CSP `script-src` has a `sha256-` hash, no `'unsafe-inline'`.
- CSP `style-src` is `'self'`, no `'unsafe-inline'`.
- CSP has no broad `https:` source in `img-src`.
- `_headers` ships HSTS, COOP, frame-ancestors, X-Frame-Options.
- No CSP `<meta>` tag in any built HTML.
- **Every shipped `.html` is CSP-clean** — auto-discovered from `dist/` (top level + `dist/apps/`). No inline `<style>` blocks, no `style="..."` attrs, no executable inline `<script>`, no `on*=` event handlers. JSON islands (`<script type="application/json">`) are fine — browsers treat them as inert data. (See "CSP-clean static pages" below for the dev rule.)

A regression in any of these fails the build. That's the contract.

## CSP-clean static pages — dev rule

The site-wide CSP (`/*` in `dist/_headers`) is `script-src 'self' 'sha256-<one-hash>'; style-src 'self';`. The one whitelisted script hash matches the no-flash theme bootstrap in `templates/index.html` — nothing else. So **any** new HTML you ship at `dist/` root or under `dist/apps/` must be CSP-clean:

- **No inline `<style>` blocks.** Put page-specific styles in `style.css` with a page-prefixed class (`.gs-*`, `.ai-*`, `.contrib-*`, `.tier-*`, `.guide-*`, etc.). Reuse the utility classes from the bottom of `style.css` (`.text-accent-bold`, `.text-pro-bold`, `.lede`, `.section-h2`, `.tile`, `.tile-grid`, `.mt-half`, `.aside-note`, `.footer-link-pro`, …) before inventing new ones.
- **No `style="..."` attributes.** Same rule. For dynamic values (e.g. per-app icon backgrounds), use the `card-styles.css` pattern: generate a single stylesheet at build time with one rule per `data-id`, and reference the data via attribute selectors instead of inline style.
- **No executable inline `<script>`.** Extract to a file in the project root, add it to `filesToCopy[]` in `build.js`, and reference it with `<script src="/foo.js" integrity="{{SRI_FOO_JS}}"></script>`. The build pipeline computes the SRI hash at build time and substitutes the placeholder. JSON data islands (`<script type="application/json">`) are fine — they're data, not code.
- **No `onclick=`, `onerror=`, or other `on*=` attributes.** Use `addEventListener` from your external script. Hook elements by `id` or a data attribute.

The regression test (`test/build.test.mjs`, `every shipped .html is CSP-clean`) walks every `.html` under `dist/` and asserts all four rules. Adding a new page without following them fails CI before the page can ship broken.

## Known open questions

These are *intentional* deferrals — listed so a security reviewer doesn't
have to find them by archaeology.

1. **Iframe sandbox** retains `allow-same-origin allow-scripts` because
   iframed apps need their own cookies/localStorage to work. Acceptable
   only as long as every iframed app is first-party (built under the
   `freeappstore-online` GitHub org and deployed by us). The moment
   third-party app submissions open, revisit this — likely route apps
   through a sandboxed subdomain (`*.embed.freeappstore.online`) with a
   tighter sandbox.

2. **Session token lives in `localStorage`.** XSS-extractable. The real
   fix is HttpOnly cookies issued by `api.freeappstore.online`. The
   frontend is ready (token shape-checked at the source); needs the API
   worker change.

3. **CSP reporting endpoint not wired.** `Content-Security-Policy-Report-Only`
   is set, but no `report-to` group + endpoint. Once
   `api.freeappstore.online/v1/csp-report` exists, point Report-To at it.

4. **`avatarUrl` from the API isn't host-locked.** Under the current CSP,
   any HTTPS image loads. Not exploitable as code, but lets a malicious
   API exfiltrate user IPs via image-pixel. Server-side trust assumption
   today; tighten with a known-CDN allowlist when the API ships.

## Reporting

Security issues that affect users should go to the maintainer rather than
a public issue. Open a private security advisory on the repo or email the
maintainer listed in `package.json`.

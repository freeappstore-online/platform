# @freeappstore/compliance

Compliance checks for apps published on **freeappstore.online**. Same checks the CLI runs locally and the template's CI runs on every push.

```ts
import { runChecks } from '@freeappstore/compliance';

const results = await runChecks(process.cwd());
for (const r of results) {
  console.log(`${r.status}  ${r.name}  ${r.detail}`);
  for (const s of r.suggestions ?? []) console.log(`   → ${s}`);
}
```

## Checks (v0.1.0)

| Name | What it checks | Status on fail |
|---|---|---|
| `No template placeholders` | No file still contains `APPNAME` | **fail** |
| `Analytics routed through platform loader` | No direct install of google-analytics / gtag / amplitude / mixpanel / segment / hotjar / plausible / posthog — analytics must flow through `api.freeappstore.online/v1/analytics.js?app=<id>` | **fail** |
| `No payments (free tier)` | No Payment Request API, Apple Pay, checkout SDKs / links (Stripe, PayPal, Paddle, Lemon Squeezy, Gumroad, Google Pay) or payment manifest members | **fail** |
| `No ads` | No ad network scripts, SDKs or packages (AdSense, Ad Manager / GPT, IMA, H5 Games Ads / AdMob, Amazon APS, Prebid, Media.net, Carbon Ads, BuySellAds, EthicalAds, Ezoic, PropellerAds, Adsterra, Taboola, Outbrain, Poki / CrazyGames / GameDistribution / GameMonetize ad SDKs). `checkNoAdsLive` runs the same patterns over published HTML in the weekly audit | **fail** |
| `Brand fonts present` | Manrope + Fraunces referenced in CSS or HTML | **fail** |
| `PWA manifest` | `web/public/manifest.json` exists and has name / short_name / start_url / display | warn |
| `Bundle size` | Initial-load JS (entry + static imports) ≤ 300 KB gzipped; lazy wasm/workers/dynamic chunks ≤ 25 MB each | **fail** if either cap is exceeded; warn if not built yet |

## Styling checks (warn-only rollout, #324)

- `CSS discipline`: PostCSS parses `web/src/**/*.css` and reports banned token
  aliases, unlayered rules, hex colours outside token blocks, per-screen dark
  overrides, and more than 15 feature classes per stylesheet.
- `No excessive inline styles`: vendored from FreeGameStore's platform check;
  warns above 15 `style={{...}}` objects per TSX file or 30 total. Tests and
  comments are excluded. FAS permits genuinely dynamic values with a reason
  commented beside them; static appearance belongs in Tailwind on FAS tokens.
- `Opaque surfaces`: warns for alpha colours in `--paper`, `--panel`, or
  `--popover`, in either theme. `--panel-glass` and `--scrim` are exempt.

`fas check --json` includes these warnings without failing the app build.
`pnpm lint:platform-ui` reuses all three checks for SDK UI, Console, and Admin,
and reports parsed TSX inline-style and runtime CSS injection counts. CI stays
in warn-only migration mode while #322 is pending. After migration, run
`pnpm lint:platform-ui --strict` to fail on runtime CSS injection or inline
styles without a nearby comment explaining the dynamic value.

The PAS CSS source referenced by #324 was unavailable (404); its five specified
rules are implemented here with PostCSS. The FGS inline scanner is adapted from
`freegamestore-online/platform/packages/compliance/src/checks/no-excessive-inline-styles.ts`.

## License

MIT.

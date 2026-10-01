# Fresh scaffold browser gate

`scaffold-smoke.yml` runs this suite for both `fas init` templates on desktop
and mobile Chromium. It first tests the published SDK a new contributor gets,
then installs a tarball of the checkout SDK and repeats the suite. A failure
fails the scaffold job; screenshots and traces are uploaded on failure.
SDK, CLI, browser test, and workflow changes trigger the gate, as do daily runs.

To reproduce from the platform root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @freeappstore/compliance build
pnpm --filter @freeappstore/cli build
pnpm --filter @freeappstore/e2e exec playwright install chromium
# Run init outside this pnpm workspace, then install the generated app.
# Substitute an absolute app path and standalone or connected below.
SCAFFOLD_DIR=/absolute/path/to/app SCAFFOLD_TEMPLATE=standalone \
  pnpm --filter @freeappstore/e2e exec playwright test --config scaffold.config.ts
```

Playwright starts and stops the scaffold's Vite dev server. The default app is
checked before any test instrumentation. Auth uses a test-only stored session
and deterministic API responses; the signed-out connected gate is checked first.
This proves UI gating, not the external OAuth flow. Analytics requests return an
empty script rather than contacting production; other backend calls return data
fixtures. No production credentials are used.

The resilience test temporarily adds buttons inside the scaffold's existing
Shell to trigger a render error and toasts, waits for Vite to observe the edit,
and restores the source in `finally`. Browser offline mode drives actual
online/offline events. One worker keeps edits isolated across browser projects.
Use disposable scaffolds for this test.

The Footer intentionally renders only in installed PWA mode. The ordinary tab
asserts its absence; a separate browser test emulates iOS `navigator.standalone`
and verifies the real footer landmark and store link. It does not install a PWA
or claim physical-device coverage. Mobile coverage uses Chromium with an iPhone
viewport/touch configuration, not Safari.

Both templates need CSS for `html[data-text='lg']` and `html[data-text='sm']`.
The browser test checks computed font size and persisted preferences, so a toggle
that only changes its button label cannot pass.

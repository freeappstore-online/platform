# Admin styling migration (#323)

Before and after Chromium captures at 1440 × 1000 (full page), using the same
local API fixtures in `workers/admin/web/tests/styling.spec.ts`. No live admin
account or production records were used. The before captures precede the
migration; the after captures use Tailwind on semantic tokens.

Panels and the sticky header are now opaque in both themes. Explicit glass and
scrim tokens remain separate. Status tints use the corresponding theme's semantic
color, and errors use `text-danger` in both themes. Layout and interactions are
preserved. Buttons, inputs, selects, panels, tabs and status badges share local
React components. The migration also replaces direct DOM hover styles and
long-hand token utilities. No inline styles remain.

| Screen / state | Before light | After light | Before dark | After dark |
| --- | --- | --- | --- | --- |
| Sign in | [Before](before/sign-in-light.png) | [After](after/sign-in-light.png) | [Before](before/sign-in-dark.png) | [After](after/sign-in-dark.png) |
| Overview | [Before](before/overview-light.png) | [After](after/overview-light.png) | [Before](before/overview-dark.png) | [After](after/overview-dark.png) |
| Apps | [Before](before/apps-light.png) | [After](after/apps-light.png) | [Before](before/apps-dark.png) | [After](after/apps-dark.png) |
| App detail, expanded session | [Before](before/app-detail-light.png) | [After](after/app-detail-light.png) | [Before](before/app-detail-dark.png) | [After](after/app-detail-dark.png) |
| Deprovision confirmation | [Before](before/deprovision-light.png) | [After](after/deprovision-light.png) | [Before](before/deprovision-dark.png) | [After](after/deprovision-dark.png) |
| Provision | [Before](before/provision-light.png) | [After](after/provision-light.png) | [Before](before/provision-dark.png) | [After](after/provision-dark.png) |
| AI grants / keys | [Before](before/ai-grants-light.png) | [After](after/ai-grants-light.png) | [Before](before/ai-grants-dark.png) | [After](after/ai-grants-dark.png) |
| Content: KV | [Before](before/content-kv-light.png) | [After](after/content-kv-light.png) | [Before](before/content-kv-dark.png) | [After](after/content-kv-dark.png) |
| Content: collections | [Before](before/content-collections-light.png) | [After](after/content-collections-light.png) | [Before](before/content-collections-dark.png) | [After](after/content-collections-dark.png) |
| Content: counters | [Before](before/content-counters-light.png) | [After](after/content-counters-light.png) | [Before](before/content-counters-dark.png) | [After](after/content-counters-dark.png) |
| Agent sessions | [Before](before/agent-sessions-light.png) | [After](after/agent-sessions-light.png) | [Before](before/agent-sessions-dark.png) | [After](after/agent-sessions-dark.png) |
| Agent conversation | [Before](before/agent-session-light.png) | [After](after/agent-session-light.png) | [Before](before/agent-session-dark.png) | [After](after/agent-session-dark.png) |

To run the source/theme guards and browser checks:

```sh
cd workers/admin/web
pnpm install --frozen-lockfile --ignore-workspace
pnpm exec playwright install chromium
pnpm build
pnpm test
```

Set `ADMIN_SCREENSHOTS=../../../docs/screenshots/admin-323/after` when running
`pnpm test` to refresh the after images. `ADMIN_BASELINE=1` disables migration-only
assertions when capturing the original implementation; it must be unset for
normal validation. CI builds and tests the admin web project separately from the
worker because each has its own lockfile.

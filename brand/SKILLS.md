# FreeAppStore brand guidance

The maintained app-building guide is [sites/storefront/SKILLS.md](../sites/storefront/SKILLS.md). The detailed identity and visual conventions are in [BRAND.md](BRAND.md).

- Body font: Manrope. Display font: Fraunces. Use the template's system and monospace fallbacks.
- Use the shared CSS variables and the SDK `Shell` with one `nav` entry per screen. Start screens with `PageHeader`; use SDK feedback and UI components.
- FreeAppStore's accent is blue (`#2563eb`); its mark also uses purple. FreeGameStore has a separate identity.
- Use the standard theme and text-size controls. Do not maintain a second header or navigation system inside an app screen.
- Apps have client-side bundles hosted on R2; connected features use the shared SDK backend. A standalone app may use localStorage or IndexedDB.
- Public build configuration belongs in the app's GitHub Actions variables and workflow. Do not commit secrets or place them in `VITE_*` values; those become public browser code. Use the platform secret store or user key vault.
- Run `fas check` and the relevant responsive browser checks before publishing.

See [Getting Started](../docs/getting-started.md#build-your-app-on-the-shell), [UI Components](../docs/ui.md), [Browser Capabilities](../docs/capabilities.md), and [Publishing](../docs/publishing.md). This file is a pointer and brand summary, not a duplicate SDK or infrastructure manual.

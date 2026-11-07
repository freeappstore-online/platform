/** Canonical worker-safe editable starter foundation. */

import { planCapabilityChanges } from './capability-definitions.js';
import { CONNECTED_DRAFT } from './developer-recipes.js';
import {
  APP_DEPLOY_CLI_VERSION,
  CODE_HEALTH_CLI_VERSION,
  DEPLOY_ACTIONS,
  INSTALL_APP_DEPENDENCIES,
  SAVE_APP_DEPENDENCY_LOCK,
} from './starter-dependencies.js';
import { resolveStarterPreset } from './starter-presets.js';

export interface StoreConfig {
  store: 'apps' | 'games';
  r2Bucket: string;
  nounPlural: string;
}
export const APP_STARTER_CONFIG: StoreConfig = {
  store: 'apps',
  r2Bucket: 'fas-apps',
  nounPlural: 'apps',
};

export type AppPreset = 'standalone' | 'connected';

export type AppArchetype = 'dashboard' | 'tracker' | 'calculator' | 'generic';

export const APP_ARCHETYPES: readonly AppArchetype[] = [
  'dashboard',
  'tracker',
  'calculator',
  'generic',
];

// ── Shared template files (identical for apps and games) ──

const SHARED_FILES: Record<string, string> = {
  'pnpm-workspace.yaml': `packages:\n  - web\n`,

  'package.json': `{
  "name": "APPNAME",
  "private": true,
  "packageManager": "pnpm@10.30.3",
  "engines": { "node": ">=22" },
  "pnpm": { "onlyBuiltDependencies": ["esbuild"] },
  "scripts": {
    "dev": "pnpm --filter @APPNAME/web dev",
    "build": "pnpm --filter @APPNAME/web build",
    "preview": "pnpm --filter @APPNAME/web preview",
    "typecheck": "pnpm --filter @APPNAME/web exec tsc -b",
    "test": "pnpm build"
  }
}`,

  'web/package.json': `{
  "name": "@APPNAME/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19",
    "react-dom": "^19",
    "@freeappstore/sdk": "^0.16.39"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4.3",
    "tailwindcss": "^4.1",
    "typescript": "^5.7",
    "@types/node": "^22.20.2",
    "happy-dom": "^20.14.5",
    "vitest": "^4.1.11",
    "vite": "^6"
  }
}`,

  'web/vite.config.ts': `
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
});`,

  'web/tsconfig.json': `{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }]
}`,

  'web/tsconfig.app.json': `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src"]
}`,

  'web/tsconfig.node.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["vite.config.ts"]
}`,

  'web/src/main.tsx': `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);`,

  '.gitignore': `node_modules\ndist\n.DS_Store\n*.local\n`,
};

// ── Apps-specific template files ──

const APP_FILES: Record<string, string> = {
  'web/src/starter.test.ts': `// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

it('uses this scaffold id for synthetic authenticated SDK requests', async () => {
  localStorage.setItem('fas:session', JSON.stringify({ token: 'synthetic-token', user: { id: 'synthetic-user', login: 'synthetic' } }));
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response('null', { status: 200 });
  });
  const { fas } = await import('./App');
  await fas.kv.get('identity-probe');
  expect(requests).toContain('https://api.freeappstore.online/v1/apps/APPID/roles/ensure-member');
  expect(requests).toContain('https://api.freeappstore.online/v1/apps/APPID/kv/identity-probe');
});
`,
  'CLAUDE.md': `# Editable FreeAppStore starter

This source is app-owned after scaffolding. Keep existing screens, layouts and data.
The SDK Shell is the supported default; a custom accessible frame is supported.
Keep a reachable Profile in both auth states, shared theme/text preferences,
keyboard navigation, visible focus, loading/error feedback and page zoom.
Public screens stay public; gate private features at their data boundary.
Share the existing SDK/Auth instance with Shell, Profile and connected features.

Choose device-local, private-account, public-shared or room storage for the feature.
Never treat collections or room broadcasts as private storage. Do not ask end users
for developer API keys: the SDK proxy supports server-side key injection.
No payments, ads or direct trackers. Preserve SDK Tailwind @source and @theme wiring.

Use fas add <capability> --dry-run for infrastructure changes. Resolve reported
package prerequisites before applying; root recipe imports need a root SDK dependency.
Keep edited capability files and review conflicts rather than overwriting them.
Keep one PWA controller and register busy guards for unsaved work and capture.

Before reporting completion, typecheck and build; exercise a real user flow,
including sequential keyboard typing (not only programmatic fill), associated
labels, save + reload, validation failures, and avatar/Profile return navigation.
Check the browser favicon separately from the PWA manifest/install icon.
Dev/build generates raster icons from the app-owned SVG using web/pwa-assets.config.ts.
Keep custom artwork, HTML and manifest paths consistent; prebuilt custom icons are supported.
Remove the generated-asset .gitignore entries if adopting prebuilt icons at those paths.
Profile is a separate route: keep drafts/reading position in app-owned route state and
pause playback or capture in effect cleanup. A PWA busy guard only guards updates.
Use available browser tooling; state explicitly when runtime checks were not run.
Practical review guide:
https://github.com/freeappstore-online/platform/blob/main/docs/app-verification.md
Optional editable form/dialog example:
https://github.com/freeappstore-online/platform/blob/main/docs/ui.md#editable-forms

Canonical source and guidance:
https://github.com/freeappstore-online/platform/blob/main/docs/composable-starter-contract.md
https://github.com/freeappstore-online/platform/blob/main/docs/starter-release.md
https://github.com/freeappstore-online/platform/blob/main/CONTRIBUTING.md#updating-the-external-app-starter-repositories
`,
  'web/src/vite-env.d.ts': `/// <reference types="vite/client" />\n`,
  'web/index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,700;9..144,800&display=swap" rel="stylesheet" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" sizes="180x180" />
    <link rel="manifest" href="/manifest.json" />
    <meta name="theme-color" content="#2563eb" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <title>APPNAME — FreeAppStore</title>
    <link rel="canonical" href="https://APPID.freeappstore.online/" />
    <meta property="og:title" content="APPNAME — FreeAppStore" />
    <meta property="og:url" content="https://APPID.freeappstore.online/" />
    <meta name="twitter:card" content="summary" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,

  'web/public/manifest.json': `{
  "name": "APPNAME",
  "short_name": "APPNAME",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#2563eb",
  "orientation": "any"
}`,

  'web/src/index.css': `@import "tailwindcss";
@source "../node_modules/@freeappstore/sdk/dist";
@source "../../node_modules/@freeappstore/sdk/dist";

@theme inline {
  --color-paper: var(--paper);
  --color-paper-deep: var(--paper-deep, var(--paper));
  --color-ink: var(--ink);
  --color-ink-strong: var(--ink-strong, var(--ink));
  --color-muted: var(--muted);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong, var(--line));
  --color-panel: var(--panel);
  --color-panel-glass: var(--panel-glass, var(--panel));
  --color-popover: var(--popover, var(--paper));
  --color-accent: var(--accent);
  --color-accent-soft: var(--accent-soft, var(--accent));
  --color-accent-deep: var(--accent-deep, var(--accent));
  --color-accent-hover: var(--accent-hover, var(--accent));
  --color-sky: var(--sky, #0ea5e9);
  --color-sky-soft: var(--sky-soft, #e0f2fe);
  --color-sky-deep: var(--sky-deep, #0369a1);
  --color-mint: var(--mint, #10b981);
  --color-mint-soft: var(--mint-soft, #d1fae5);
  --color-mint-deep: var(--mint-deep, #047857);
  --color-success: var(--success);
  --color-success-soft: var(--success-soft, var(--success));
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft, var(--warning));
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft, var(--danger));
  --color-scrim: var(--scrim, rgb(0 0 0 / 45%));
  --radius: var(--radius, 12px);
  --radius-sm: var(--radius-sm, 8px);
  --radius-lg: var(--radius-lg, var(--radius));
  --shadow-sm: var(--shadow, 0 1px 2px rgb(0 0 0 / 8%));
  --shadow-lg: var(--shadow-lg, 0 12px 32px rgb(0 0 0 / 18%));
}

@theme {
  --animate-sdk-fade-in: sdk-fade-in 150ms ease-out;
  --animate-sdk-slide-up: sdk-slide-up 200ms ease-out;
  --animate-sdk-drawer: sdk-drawer 200ms ease-out;
  @keyframes sdk-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes sdk-slide-up {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes sdk-drawer {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
}

:root {
  --paper: #ffffff;
  --ink: #1a1a1a;
  --muted: #6b7280;
  --line: #e5e7eb;
  --line-strong: #d1d5db;
  --panel: #f9fafb;
  --success: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
  --accent: #2563eb;
  --paper-deep: #f3f4f6;
  --ink-strong: var(--ink);
  --panel-glass: rgba(255, 255, 255, 0.72);
  --popover: var(--paper);
  --scrim: rgba(0, 0, 0, 0.5);
  --accent-soft: #dbeafe;
  --accent-deep: #1e40af;
  --accent-hover: var(--accent-deep);
  --sky: #0284c7;
  --sky-soft: #e0f2fe;
  --sky-deep: #075985;
  --mint: #059669;
  --mint-soft: #d1fae5;
  --mint-deep: #065f46;
  --success-soft: color-mix(in srgb, var(--success) 15%, var(--paper));
  --warning-soft: color-mix(in srgb, var(--warning) 15%, var(--paper));
  --danger-soft: color-mix(in srgb, var(--danger) 15%, var(--paper));
  --radius: 0.75rem;
  --radius-sm: 0.5rem;
  --radius-lg: 1rem;
  --shadow: 0 12px 28px rgba(26, 41, 81, 0.08);
  --shadow-lg: var(--shadow);
  --font-display: "Fraunces", Georgia, serif;
  font-family: "Manrope", system-ui, sans-serif;
}

/* Dark mode: the SDK sets data-theme="dark" on <html> when the system is dark
   or the user picks dark in the Shell's theme toggle. */
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0f0f0f;
  --ink: #f5f5f5;
  --muted: #9ca3af;
  --line: #2d2d2d;
  --line-strong: #404040;
  --panel: #1a1a1a;
  --success: #22c55e;
  --warning: #fbbf24;
  --danger: #ef4444;
  --paper-deep: #0a0a0a;
  --panel-glass: rgba(26, 26, 26, 0.8);
  --accent: #60a5fa;
  --accent-soft: #172554;
  --accent-deep: #bfdbfe;
  --sky: #38bdf8;
  --sky-soft: #082f49;
  --sky-deep: #bae6fd;
  --mint: #34d399;
  --mint-soft: #022c22;
  --mint-deep: #a7f3d0;
  --shadow: 0 12px 28px rgba(0, 0, 0, 0.4);
}

/* Shell text preferences scale rem-based typography without blocking zoom. */
:root[data-text="lg"] { font-size: 112.5%; }
:root[data-text="sm"] { font-size: 87.5%; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
}

h1,
h2,
h3 {
  font-family: var(--font-display);
}`,

  'web/src/App.tsx': `import { useEffect, useState } from "react";
import { initApp } from "@freeappstore/sdk";
import { type NavItem, PageHeader, Shell } from "@freeappstore/sdk/ui";

// "APPID" is replaced by the CLI scaffold or deployment flow with this app's id.
export const fas = initApp({ appId: "APPID" });

// The app's screens. Shell renders them as the navbar: a <nav> in its topbar
// with the current screen highlighted, collapsing to a menu on phones.
// Add one entry per primary screen; \`title\` becomes the browser tab title.
const NAV: NavItem[] = [
  { label: "Home", href: "/", title: "APPNAME_JS" },
  { label: "About", href: "/about", title: "About — APPNAME_JS" },
];

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);

  // Keep the screen in step with the browser's back and forward buttons.
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Nav clicks switch screens without a page load. Shell scrolls to the top
  // and moves focus to the new screen's PageHeader.
  const navigate = (href: string) => {
    window.history.pushState(null, "", href);
    setPath(window.location.pathname);
  };

  return (
    <Shell app={fas} appName={"APPNAME_JS"} nav={NAV} onNavigate={navigate}>
      <div className="mx-auto w-full max-w-3xl p-4 sm:p-8">
        {path === "/about" ? <About /> : <Home />}
      </div>
    </Shell>
  );
}

function Home() {
  return <PageHeader title={"Welcome to APPNAME_JS"} description="Edit web/src/App.tsx to get started." />;
}

function About() {
  return (
    <>
      <PageHeader title="About" />
      <p style={{ color: "var(--muted)" }}>
        APPNAME_TEXT is a free app on <a href="https://freeappstore.online">FreeAppStore</a>.
      </p>
    </>
  );
}`,

  LICENSE: `MIT License

Copyright (c) 2025 FreeAppStore

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
};

const DASHBOARD_FILES: Record<string, string> = {
  'web/src/components/Dashboard.tsx': `const stats = [
  { label: "Revenue", value: "$24.8k", delta: "+12%" },
  { label: "Active users", value: "1,284", delta: "+8%" },
  { label: "Conversion", value: "6.2%", delta: "+1.4%" },
  { label: "Open tasks", value: "17", delta: "-3" },
];

export function Dashboard() {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold" style={{ fontFamily: "Fraunces, serif" }}>
          Dashboard
        </h2>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Track the signals that matter most.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <article
            key={stat.label}
            className="rounded-2xl border p-4"
            style={{ borderColor: "var(--line)", background: "var(--panel)" }}
          >
            <p className="text-sm font-medium" style={{ color: "var(--muted)" }}>
              {stat.label}
            </p>
            <div className="mt-3 flex items-end justify-between gap-3">
              <strong className="text-2xl">{stat.value}</strong>
              <span className="rounded-full px-2 py-1 text-xs font-semibold" style={{ color: "var(--success)", background: "var(--paper)" }}>
                {stat.delta}
              </span>
            </div>
          </article>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <article className="min-h-72 rounded-2xl border p-5" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Trend overview</h3>
            <span className="text-sm" style={{ color: "var(--muted)" }}>Last 30 days</span>
          </div>
          <div className="mt-8 flex h-44 items-end gap-3">
            {[42, 68, 52, 76, 64, 86, 72, 94].map((height, index) => (
              <div key={index} className="flex-1 rounded-t-xl" style={{ height: height + "%", background: "var(--accent)" }} />
            ))}
          </div>
        </article>
        <article className="rounded-2xl border p-5" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
          <h3 className="font-semibold">Next actions</h3>
          <ul className="mt-4 space-y-3 text-sm">
            {["Review weekly progress", "Prioritize stalled work", "Share update"].map((item) => (
              <li key={item} className="rounded-xl border px-3 py-2" style={{ borderColor: "var(--line)", background: "var(--paper)" }}>
                {item}
              </li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}
`,
};

const TRACKER_FILES: Record<string, string> = {
  'web/src/components/Tracker.tsx': `import { useMemo, useState } from "react";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

const initialItems: Item[] = [
  { id: "welcome", title: "Define the first thing to track", done: false },
  { id: "sample", title: "Mark an item complete", done: true },
];

export function Tracker() {
  const [items, setItems] = useState<Item[]>(initialItems);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const remaining = useMemo(() => items.filter((item) => !item.done).length, [items]);
  const editingItem = items.find((item) => item.id === editingId);

  function saveItem() {
    const title = draft.trim();
    if (!title) return;
    if (editingId) {
      setItems((current) => current.map((item) => (item.id === editingId ? { ...item, title } : item)));
      setEditingId(null);
    } else {
      setItems((current) => [{ id: crypto.randomUUID(), title, done: false }, ...current]);
    }
    setDraft("");
  }

  function startEdit(item: Item) {
    setEditingId(item.id);
    setDraft(item.title);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft("");
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold" style={{ fontFamily: "Fraunces, serif" }}>
            Tracker
          </h2>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {remaining} open item{remaining === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      <div className="rounded-2xl border p-4" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
        <label className="text-sm font-semibold" htmlFor="tracker-item">
          {editingItem ? "Edit item" : "Add item"}
        </label>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            id="tracker-item"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveItem();
              if (event.key === "Escape") cancelEdit();
            }}
            placeholder="What needs tracking?"
            className="min-h-11 flex-1 rounded-xl border px-3 outline-none"
            style={{ borderColor: "var(--line)", background: "var(--paper)", color: "var(--ink)" }}
          />
          <button type="button" onClick={saveItem} className="min-h-11 rounded-xl px-4 font-semibold text-white" style={{ background: "var(--accent)" }}>
            {editingItem ? "Save" : "Add"}
          </button>
          {editingItem && (
            <button type="button" onClick={cancelEdit} className="min-h-11 rounded-xl border px-4 font-semibold" style={{ borderColor: "var(--line)" }}>
              Cancel
            </button>
          )}
        </div>
      </div>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="rounded-2xl border p-4" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <label className="flex flex-1 items-center gap-3">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, done: !entry.done } : entry)))}
                  className="size-5"
                />
                <span className={item.done ? "line-through" : ""} style={{ color: item.done ? "var(--muted)" : "var(--ink)" }}>
                  {item.title}
                </span>
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={() => startEdit(item)} className="rounded-xl border px-3 py-2 text-sm font-semibold" style={{ borderColor: "var(--line)" }}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
                  className="rounded-xl border px-3 py-2 text-sm font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--danger)" }}
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
`,
};

const CALCULATOR_FILES: Record<string, string> = {
  'web/src/components/Calculator.tsx': `import { useMemo, useState } from "react";

const buttons = ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "=", "+"];

function evaluateExpression(expression: string): string {
  if (!/^[0-9+\\-*/. ()]+$/.test(expression)) return "Error";
  try {
    const value = Function('"use strict"; return (' + expression + ')')();
    return Number.isFinite(value) ? String(Number(value.toFixed(8))) : "Error";
  } catch {
    return "Error";
  }
}

export function Calculator() {
  const [display, setDisplay] = useState("0");
  const isError = display === "Error";
  const preview = useMemo(() => {
    if (isError || display === "0" || /[+\\-*/.]$/.test(display)) return "";
    const result = evaluateExpression(display);
    return result !== "Error" && result !== display ? result : "";
  }, [display, isError]);

  function press(key: string) {
    if (key === "=") {
      setDisplay((current) => evaluateExpression(current));
      return;
    }
    setDisplay((current) => (current === "0" || current === "Error" ? key : current + key));
  }

  return (
    <section className="mx-auto max-w-sm space-y-4">
      <div>
        <h2 className="text-2xl font-bold" style={{ fontFamily: "Fraunces, serif" }}>
          Calculator
        </h2>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          A compact expression calculator.
        </p>
      </div>
      <div className="rounded-2xl border p-4 shadow-sm" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
        <div className="min-h-28 rounded-2xl border p-4 text-right" style={{ borderColor: "var(--line)", background: "var(--paper)" }}>
          <div className="break-all text-3xl font-bold">{display}</div>
          <div className="mt-2 min-h-5 text-sm" style={{ color: "var(--muted)" }}>
            {preview}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => setDisplay("0")}
            className="col-span-2 min-h-12 rounded-xl border font-semibold"
            style={{ borderColor: "var(--line)" }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setDisplay((current) => (current.length > 1 && current !== "Error" ? current.slice(0, -1) : "0"))}
            className="col-span-2 min-h-12 rounded-xl border font-semibold"
            style={{ borderColor: "var(--line)" }}
          >
            Back
          </button>
          {buttons.map((button) => (
            <button
              key={button}
              type="button"
              onClick={() => press(button)}
              className="min-h-12 rounded-xl border text-lg font-semibold"
              style={{
                borderColor: "var(--line)",
                background: button === "=" ? "var(--accent)" : "var(--paper)",
                color: button === "=" ? "#fff" : "var(--ink)",
              }}
            >
              {button}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
`,
};

const APP_ARCHETYPE_FILES: Record<AppArchetype, Record<string, string>> = {
  dashboard: DASHBOARD_FILES,
  tracker: TRACKER_FILES,
  calculator: CALCULATOR_FILES,
  generic: {},
};

// ── Games-specific template files ──

const GAME_FILES: Record<string, string> = {
  'web/index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,700;9..144,800&display=swap" rel="stylesheet" />
    <link rel="manifest" href="/manifest.json" />
    <meta name="theme-color" content="#10b981" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <title>APPNAME — FreeGameStore</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,

  'web/public/manifest.json': `{
  "name": "APPNAME",
  "short_name": "APPNAME",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f0f0f",
  "theme_color": "#10b981",
  "orientation": "any"
}`,

  'web/src/index.css': `@import "tailwindcss";

:root {
  /* Games use the same canonical token names as apps (DESIGN-SYSTEM.md bans
     the old background alias everywhere); only the values are game-dark. */
  --paper: #0f0f0f;
  --panel: #1a1a1a;
  --ink: #f0f0f0;
  --muted: #999;
  --accent: #10b981;
  --line: #2a2a2a;
  --success: #22c55e;
  --warning: #fbbf24;
  --danger: #ef4444;
  font-family: "Manrope", system-ui, sans-serif;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  overflow: hidden;
}

#root {
  width: 100vw;
  height: 100dvh;
  overflow: hidden;
}`,

  'web/src/components/GameShell.tsx': `import type { ReactNode } from "react";

interface GameShellProps {
  title: string;
  children: ReactNode;
}

/** GameShell: full-viewport wrapper with a 44px top bar and game canvas area.
 *  The topbar shows the game name and a link to FreeGameStore.
 *  The children fill the remaining viewport height. */
export function GameShell({ title, children }: GameShellProps) {
  return (
    <div style={{ width: "100vw", height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--paper)" }}>
      <header style={{ height: 44, minHeight: 44, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 1rem", background: "var(--panel)", borderBottom: "1px solid var(--line)", fontSize: "0.85rem" }}>
        <span style={{ fontWeight: 700, fontFamily: "Fraunces, serif" }}>{title}</span>
        <a href="https://freegamestore.online" target="_blank" rel="noopener noreferrer" style={{ color: "var(--muted)", fontSize: "0.75rem", textDecoration: "none" }}>
          FreeGameStore
        </a>
      </header>
      <main style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {children}
      </main>
    </div>
  );
}`,

  'web/src/App.tsx': `import { GameShell } from "./components/GameShell";

export default function App() {
  return (
    <GameShell title={"APPNAME_JS"}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: "1rem" }}>
        <h1 style={{ fontFamily: "Fraunces, serif", fontSize: "2rem", margin: 0 }}>
          APPNAME_TEXT
        </h1>
        <p style={{ color: "var(--muted)" }}>
          Edit <code>src/App.tsx</code> to build your game.
        </p>
      </div>
    </GameShell>
  );
}`,

  LICENSE: `MIT License

Copyright (c) 2025 FreeGameStore

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
};

// ── Deploy workflow (R2) ──
//
// The single source of truth for every generated `.github/workflows/deploy.yml`:
// `fas init`, the VibeCode builder and `fas publish` all emit this function's
// output. GitHub Actions builds the app and syncs it to
// r2://<bucket>/<nounPlural>/<repo>/ — the prefix the host Worker
// (freeappstore-host / freegamestore-host) serves once the publish step writes
// the D1 routes row. Contains no APPNAME placeholder.
//
// Two jobs on purpose (mirrors freegamestore-online/ci-workflows game-ci.yml):
//   build  — installs, tests and builds the app, runs the pinned
//            @freeappstore/cli validator and the pinned code-health scan, then
//            uploads the built output as a workflow artifact. No secrets and
//            no id-token: a compromised npm release can fail the build only.
//   deploy — downloads that artifact and uploads it keylessly (#460): a GitHub
//            OIDC token opens a deploy session on the store API, which writes
//            each file under this app's own R2 prefix and switches the route
//            to the new release only once every file is in. Runs no project
//            code (no checkout, no install, no npx) and holds no R2 secret.
// Every `uses:` is commit-pinned and every `npx` names an exact version.
//
// Fresh builder apps acquire a lock on their first successful build; later
// builds retain it unless dependency manifests change (that push needs
// `contents: write` on the build job — the repo-scoped GITHUB_TOKEN, not an
// org credential).
function indent(script: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return script
    .trimEnd()
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
}

/** The store API that verifies the OIDC token and owns the bucket binding. */
const DEPLOY_API = {
  apps: 'https://api.freeappstore.online',
  games: 'https://admin.freegamestore.online',
} as const;

/**
 * The deploy job's whole client: plain bash, curl and jq from the runner image.
 * The token is requested for the store API's audience; the API maps the
 * verified repository_id to exactly one app and refuses anything else.
 */
export const KEYLESS_UPLOAD = `set -euo pipefail
cd site
test -n "$(ls -A .)" || { echo "::error::build artifact is empty"; exit 1; }
find . -type f -printf '%P\\t%s\\n' \\
  | jq -Rn '[inputs | split("\\t") | {key: .[0], value: (.[1] | tonumber)}] | from_entries' \\
  > "$RUNNER_TEMP/sizes.json"
# Content hashes let the API skip files unchanged since the live release.
find . -type f -print0 | xargs -0 sha256sum \\
  | jq -Rn '[inputs | capture("^(?<h>[0-9a-f]{64})  \\\\./(?<p>.*)$")] | map({key: .p, value: .h}) | from_entries' \\
  > "$RUNNER_TEMP/hashes.json"
jq -n --slurpfile f "$RUNNER_TEMP/sizes.json" --slurpfile h "$RUNNER_TEMP/hashes.json" \\
  '{files: $f[0], hashes: $h[0]}' > "$RUNNER_TEMP/manifest.json"
oidc=$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$DEPLOY_API" | jq -r .value)
echo "::add-mask::$oidc"
session=$(curl -sS --fail-with-body -X POST "$DEPLOY_API/v1/deploys" \\
  -H "Authorization: Bearer $oidc" -H 'Content-Type: application/json' \\
  --data-binary @"$RUNNER_TEMP/manifest.json") \\
  || { echo "::error::deploy refused: $session"; exit 1; }
printf '%s' "$session" > "$RUNNER_TEMP/session.json"
DEPLOY_TOKEN=$(jq -r .token "$RUNNER_TEMP/session.json")
echo "::add-mask::$DEPLOY_TOKEN"
DEPLOY_URL="$DEPLOY_API/v1/deploys/$(jq -r .id "$RUNNER_TEMP/session.json")"
export DEPLOY_TOKEN DEPLOY_URL
upload() {
  curl -sS --fail-with-body --retry 3 --retry-all-errors -T "./$1" \\
    -H "Authorization: Bearer $DEPLOY_TOKEN" -H 'Content-Type: application/octet-stream' \\
    "$DEPLOY_URL/files/$(jq -rn --arg p "$1" '$p | split("/") | map(@uri) | join("/")')"
}
export -f upload
if jq -e 'has("missing")' "$RUNNER_TEMP/session.json" > /dev/null; then
  # Delta: upload only what changed; the API copies the rest from the live release.
  echo "Delta deploy: $(jq '.missing | length' "$RUNNER_TEMP/session.json") to upload, $(jq '.reuse | length' "$RUNNER_TEMP/session.json") reused from the live release"
  jq -r '.missing[]' "$RUNNER_TEMP/session.json" | tr '\\n' '\\0' | xargs -0 -P 8 -n 1 bash -c 'upload "$1"' _
  reuse_batch() {
    curl -sS --fail-with-body --retry 3 --retry-all-errors -X POST \\
      -H "Authorization: Bearer $DEPLOY_TOKEN" -H 'Content-Type: application/json' \\
      --data-binary "$1" "$DEPLOY_URL/reuse" -w "reuse batch: HTTP %{http_code} in %{time_total}s\\n"
  }
  export -f reuse_batch
  jq -c '.reuse as $r | if ($r | length) == 0 then empty else ($r | _nwise(100) | {paths: .}) end' \\
    "$RUNNER_TEMP/session.json" | tr '\\n' '\\0' | xargs -0 -P 3 -n 1 bash -c 'reuse_batch "$1"' _
else
  find . -type f -printf '%P\\0' | xargs -0 -P 8 -n 1 bash -c 'upload "$1"' _
fi
curl -sS --fail-with-body -X POST -H "Authorization: Bearer $DEPLOY_TOKEN" "$DEPLOY_URL/commit"
echo
echo "Deployed \${GITHUB_REPOSITORY##*/} from \${GITHUB_SHA::7}"
`;

export function deployWorkflow(config: StoreConfig): string {
  const apps = config.store === 'apps';
  const cli = `npx --yes @freeappstore/cli@${APP_DEPLOY_CLI_VERSION}`;
  const buildSteps = apps
    ? `      - name: Install
        run: |
${indent(INSTALL_APP_DEPENDENCIES, 10)}
      # If your app uses VITE_* public config (OAuth client IDs, Firebase
      # config, etc.), add them as GitHub repo Variables and pass them to the
      # Build step. See https://freeappstore.online/skills.md "App Config & Secrets".
      # Example:
      #   env:
      #     VITE_GOOGLE_CLIENT_ID: \${{ vars.VITE_GOOGLE_CLIENT_ID }}
      - name: Resolve build target
        id: target
        run: ${cli} build-target --app-id "\${GITHUB_REPOSITORY##*/}" --github-output
      - name: Typecheck (when configured)
        run: pnpm run --if-present typecheck
      - name: Tests (when configured)
        run: pnpm run --if-present test
      - name: Build
        env:
          BUILD_COMMAND: \${{ steps.target.outputs.build-command }}
          VITE_APP_VERSION: \${{ github.event.repository.name }}@\${{ github.run_number }}
          VITE_COMMIT_SHA: \${{ github.sha }}
          VITE_BUILD_DATE: \${{ github.event.head_commit.timestamp }}
        run: bash -e -c "$BUILD_COMMAND"
      - name: Verify build output
        run: ${cli} build-target --artifact --app-id "\${GITHUB_REPOSITORY##*/}"
      # Installed size for the store's detail page (sites/storefront/build.js).
      - name: Write build info
        env:
          OUTPUT_PATH: \${{ steps.target.outputs.output-path }}
        run: echo "{\\"size\\":$(du -sb "$OUTPUT_PATH" | cut -f1)}" > "$OUTPUT_PATH/.buildinfo.json"
      - name: Retain verified dependency lock
        run: |
${indent(SAVE_APP_DEPENDENCY_LOCK, 10)}
      # Code health scan — the JSON report + badge are published next to the
      # app so the console and store listings can show them. Never blocks.
      - name: Code health scan
        run: npx --yes @vibecodeqa/cli@${CODE_HEALTH_CLI_VERSION} --json --badge > /dev/null 2>&1 || true
      - name: Upload build artifact
        uses: ${DEPLOY_ACTIONS.uploadArtifact}
        with:
          name: app
          path: \${{ steps.target.outputs.output-path }}
          include-hidden-files: true
          if-no-files-found: error
          retention-days: 1
      - name: Upload code health report
        uses: ${DEPLOY_ACTIONS.uploadArtifact}
        with:
          name: code-health
          path: |
            .vibe-check/report.json
            .vibe-check/badge.svg
          include-hidden-files: true
          if-no-files-found: ignore
          retention-days: 1
`
    : `      - name: Install
        run: pnpm install --no-frozen-lockfile
      - name: Build
        run: pnpm build
      - name: Verify build output
        run: |
          test -d ./web/dist || { echo "::error::No build output at web/dist"; exit 1; }
          test -n "$(ls -A ./web/dist)" || { echo "::error::web/dist is empty"; exit 1; }
      - name: Upload build artifact
        uses: ${DEPLOY_ACTIONS.uploadArtifact}
        with:
          name: app
          path: web/dist
          include-hidden-files: true
          if-no-files-found: error
          retention-days: 1
`;
  const codeHealthDownload = apps
    ? `      - name: Download code health report
        continue-on-error: true
        uses: ${DEPLOY_ACTIONS.downloadArtifact}
        with:
          name: code-health
          path: site/.vcqa
`
    : '';
  return `name: Deploy to R2

# Generated by @freeappstore/cli. Two jobs on purpose:
#   build  — runs the app's install/test/build plus the pinned validators.
#            No secrets here: a compromised npm package can only fail the build.
#   deploy — uploads the artifact with a GitHub OIDC token (no stored secret):
#            the store API writes it under this app's prefix and switches to it
#            once complete. Runs no project code (no checkout, install or npx).
# Regenerate with \`fas publish --update-workflow\`; do not add secrets to build.

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-\${{ github.repository }}
  cancel-in-progress: true

jobs:
  build:
    if: \${{ !startsWith(github.event.repository.name, 'template-') }}
    runs-on: ubuntu-latest
    permissions:
      contents: ${apps ? 'write' : 'read'}
    steps:
      - uses: ${DEPLOY_ACTIONS.checkout}
      - uses: ${DEPLOY_ACTIONS.pnpm}
      - uses: ${DEPLOY_ACTIONS.setupNode}
        with:
          node-version: 22
${buildSteps}
  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    env:
      DEPLOY_API: ${DEPLOY_API[config.store]}
    steps:
      - name: Download build artifact
        uses: ${DEPLOY_ACTIONS.downloadArtifact}
        with:
          name: app
          path: site
${codeHealthDownload}      - name: Upload keylessly
        run: |
${indent(KEYLESS_UPLOAD, 10)}
`;
}

// ── Public API ──

export function getArchetypeFiles(archetype: AppArchetype): Record<string, string> {
  return APP_ARCHETYPE_FILES[archetype];
}

export function getTemplateFiles(
  config: StoreConfig,
  archetype?: AppArchetype,
  preset: AppPreset = 'standalone',
): Record<string, string> {
  const appArchetypeFiles =
    config.store === 'games' ? {} : getArchetypeFiles(archetype ?? 'generic');
  const capabilities = config.store === 'apps' ? resolveStarterPreset(preset) : [];
  const foundationFiles = { ...SHARED_FILES, ...APP_FILES };
  const capabilityPlan = planCapabilityChanges(capabilities, foundationFiles, {}, () => false);
  const capabilityFiles = capabilityPlan.writes;
  const files: Record<string, string> = {
    ...SHARED_FILES,
    ...(config.store === 'games' ? GAME_FILES : APP_FILES),
    ...(config.store === 'apps'
      ? {
          'web/package.json': SHARED_FILES['web/package.json']!.replace(
            '"vite": "^6"',
            '"vite": "^6",\n    "vite-plugin-pwa": "^1.0"',
          ),
          'web/vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from '@freeappstore/sdk/pwa-config';
export default defineConfig({ plugins: [react(), tailwindcss(), VitePWA(pwaOptions())] });`,
          'web/src/pwa.ts': `// Compatibility path: the canonical app-owned controller lives in fas-capabilities/pwa.ts.
export { pwa } from './fas-capabilities/pwa';
`,
          'web/src/main.tsx': `import './fas-capabilities/pwa';\n${SHARED_FILES['web/src/main.tsx']}`,
          'web/public/icon.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="64" fill="#2563eb"/><path d="M160 160h192v48H208v48h120v48H208v48h-48z" fill="white"/></svg>`,
          'web/pwa-assets.config.ts': `import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// App-owned artwork and padding/background options. Keep manifest/HTML paths in sync.
export default defineConfig({
  preset: minimal2023Preset,
  headLinkOptions: { preset: '2023' },
  images: ['public/icon.svg'],
});
`,
          'web/public/manifest.json': JSON.stringify(
            {
              ...JSON.parse(APP_FILES['web/public/manifest.json']!),
              id: '/',
              scope: '/',
              min_viewport_width: 320,
              icons: [
                { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
                { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
                {
                  src: '/maskable-icon-512x512.png',
                  sizes: '512x512',
                  type: 'image/png',
                  purpose: 'maskable',
                },
              ],
            },
            null,
            2,
          ),
          'web/index.html': APP_FILES['web/index.html']!.replace(
            'initial-scale=1.0',
            'initial-scale=1.0, viewport-fit=cover',
          ),
          'web/src/index.css': `${APP_FILES['web/src/index.css']}
html { overflow-wrap: anywhere; }
body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
img, video, canvas { max-width: 100%; }
`,
          'fas.json': JSON.stringify(
            {
              appId: 'APPID',
              applicationRoot: 'web',
              outputPath: 'web/dist',
              buildCommand: 'pnpm build',
            },
            null,
            2,
          ),
          ...capabilityFiles,
        }
      : {}),
    ...appArchetypeFiles,
    '.github/workflows/deploy.yml': deployWorkflow(config),
  };

  if (config.store === 'apps') {
    files['web/src/index.css'] =
      `${files['web/src/index.css']!.replace('\n:root {', '\n@layer base {\n:root {')}\n}\n`;
    files['.gitignore'] +=
      `\n*.tsbuildinfo\n# Derived from icon.svg; remove these entries when using prebuilt custom icons.\n/web/public/favicon.ico\n/web/public/apple-touch-icon-180x180.png\n/web/public/pwa-64x64.png\n/web/public/pwa-192x192.png\n/web/public/pwa-512x512.png\n/web/public/maskable-icon-512x512.png\n`;
    const appPackage = JSON.parse(files['package.json']!) as {
      scripts: Record<string, string>;
      pnpm: { onlyBuiltDependencies: string[] };
    };
    appPackage.scripts.test = 'pnpm --filter @APPNAME/web test';
    appPackage.pnpm.onlyBuiltDependencies.push('sharp');
    files['package.json'] = JSON.stringify(appPackage, null, 2);
    const webPackage = JSON.parse(files['web/package.json']!) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    webPackage.devDependencies['@vite-pwa/assets-generator'] = '1.0.4';
    webPackage.scripts['generate:icons'] = 'pwa-assets-generator --manifest=false';
    webPackage.scripts.dev = 'pnpm generate:icons && vite';
    webPackage.scripts.build = 'pnpm generate:icons && vite build';
    files['web/package.json'] = JSON.stringify(webPackage, null, 2);
    const nodeConfig = JSON.parse(files['web/tsconfig.node.json']!) as { include: string[] };
    nodeConfig.include.push('pwa-assets.config.ts');
    files['web/tsconfig.node.json'] = JSON.stringify(nodeConfig, null, 2);
  }

  if (config.store === 'apps' && preset === 'connected') {
    files['web/src/App.tsx'] = files['web/src/App.tsx']!.replace(
      'import { initApp }',
      'import { ConnectedDraft } from "./components/ConnectedDraft";\nimport { initApp }',
    ).replace(
      '  return <PageHeader title={"Welcome to APPNAME_JS"} description="Edit web/src/App.tsx to get started." />;',
      '  return <><PageHeader title={"Welcome to APPNAME_JS"} description="Editable app-owned starter screen." /><ConnectedDraft app={fas} /></>;',
    );
    files['web/src/components/ConnectedDraft.tsx'] = CONNECTED_DRAFT;
  }

  return files;
}

export function substituteAppName(
  files: Record<string, string>,
  appId: string,
  displayName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const packagePath = path === 'package.json' || path === 'web/package.json';
    const replacementForPath = path.endsWith('.json')
      ? escapeJsonString(displayName)
      : path.endsWith('.html')
        ? escapeHtml(displayName)
        : displayName;
    out[path] = content.replace(/APPNAME_JS|APPNAME_TEXT|APPNAME|APPID/g, (token) => {
      if (token === 'APPID') return appId;
      if (token === 'APPNAME_JS') return escapeJavaScriptString(displayName);
      if (token === 'APPNAME_TEXT') return escapeJsxText(displayName);
      if (packagePath || path === 'pnpm-workspace.yaml') return appId;
      return replacementForPath;
    });
  }
  return out;
}

function escapeJavaScriptString(value: string): string {
  return [...value]
    .map((char) => {
      const escapes: Record<string, string> = {
        '\\': '\\\\',
        '"': '\\"',
        '\n': '\\n',
        '\r': '\\r',
        '\t': '\\t',
        '\b': '\\b',
        '\f': '\\f',
      };
      if (escapes[char]) return escapes[char];
      const codePoint = char.codePointAt(0)!;
      if (codePoint < 0x20 || codePoint === 0x2028 || codePoint === 0x2029) {
        return `\\u${codePoint.toString(16).padStart(4, '0')}`;
      }
      return char;
    })
    .join('');
}

function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char]!;
  });
}

function escapeJsxText(value: string): string {
  return escapeHtml(value).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

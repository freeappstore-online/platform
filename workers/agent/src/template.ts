/** Template files and system prompts — parameterized by store config. */

import { minVersion, subset, validRange } from "semver";
import {
  checkCapabilityPackagePrerequisites,
  planCapabilityChanges,
  resolveCapabilities,
} from "../../../packages/cli/src/lib/capability-definitions";
import { resolveStarterPreset } from "../../../packages/cli/src/lib/starter-presets";
import type { StoreConfig } from "./config";

export type AppPreset = "standalone" | "connected";

export type AppArchetype = "dashboard" | "tracker" | "calculator" | "generic";

export const APP_ARCHETYPES: readonly AppArchetype[] = ["dashboard", "tracker", "calculator", "generic"];

// ── Shared template files (identical for apps and games) ──

const SHARED_FILES: Record<string, string> = {
  "pnpm-workspace.yaml": `packages:\n  - web\n`,

  "package.json": `{
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
    "test": "pnpm --filter @APPNAME/web test"
  }
}`,

  "web/package.json": `{
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
    "@freeappstore/sdk": "^0.16.26"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.1",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4.3",
    "tailwindcss": "^4.1",
    "typescript": "^5.7",
    "vite": "^6"
  }
}`,

  "web/vite.config.ts": `
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
});`,

  "web/tsconfig.json": `{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }]
}`,

  "web/tsconfig.app.json": `{
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

  "web/tsconfig.node.json": `{
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

  "web/src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);`,

  ".gitignore": `node_modules\ndist\n.DS_Store\n*.local\n`,
};

// ── Apps-specific template files ──

const APP_FILES: Record<string, string> = {
  "web/src/vite-env.d.ts": `/// <reference types="vite/client" />\n`,
  "web/index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,700;9..144,800&display=swap" rel="stylesheet" />
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

  "web/public/manifest.json": `{
  "name": "APPNAME",
  "short_name": "APPNAME",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#2563eb",
  "orientation": "any"
}`,

  "web/src/index.css": `@import "tailwindcss";
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

  "web/src/App.tsx": `import { useEffect, useState } from "react";
import { initApp } from "@freeappstore/sdk";
import { type NavItem, PageHeader, Shell } from "@freeappstore/sdk/ui";

// "APPID" is replaced with this app's id when it deploys.
const fas = initApp({ appId: "APPID" });

// The app's screens. Shell renders them as the navbar: a <nav> in its topbar
// with the current screen highlighted, collapsing to a menu on phones.
// Add one entry per primary screen; \`title\` becomes the browser tab title.
const NAV: NavItem[] = [
  { label: "Home", href: "/", title: "APPNAME" },
  { label: "About", href: "/about", title: "About — APPNAME" },
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
    setPath(href);
  };

  return (
    <Shell app={fas} appName="APPNAME" nav={NAV} onNavigate={navigate}>
      <div className="mx-auto w-full max-w-3xl p-4 sm:p-8">
        {path === "/about" ? <About /> : <Home />}
      </div>
    </Shell>
  );
}

function Home() {
  return <PageHeader title="Welcome to APPNAME" description="Edit web/src/App.tsx to get started." />;
}

function About() {
  return (
    <>
      <PageHeader title="About" />
      <p style={{ color: "var(--muted)" }}>
        APPNAME is a free app on <a href="https://freeappstore.online">FreeAppStore</a>.
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
  "web/src/components/Dashboard.tsx": `const stats = [
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
  "web/src/components/Tracker.tsx": `import { useMemo, useState } from "react";

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
  "web/src/components/Calculator.tsx": `import { useMemo, useState } from "react";

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
  "web/index.html": `<!DOCTYPE html>
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

  "web/public/manifest.json": `{
  "name": "APPNAME",
  "short_name": "APPNAME",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f0f0f",
  "theme_color": "#10b981",
  "orientation": "any"
}`,

  "web/src/index.css": `@import "tailwindcss";

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

  "web/src/components/GameShell.tsx": `import type { ReactNode } from "react";

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

  "web/src/App.tsx": `import { GameShell } from "./components/GameShell";

export default function App() {
  return (
    <GameShell title="APPNAME">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: "1rem" }}>
        <h1 style={{ fontFamily: "Fraunces, serif", fontSize: "2rem", margin: 0 }}>
          APPNAME
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
// Every agent-pushed repo carries this so GitHub Actions builds web/dist and
// syncs it to r2://<bucket>/<nounPlural>/<repo>/ — the prefix the host Worker
// (freeappstore-host / freegamestore-host) serves once the publish step writes
// the D1 routes row. Mirrors the proven template-standalone deploy.yml.
//
// Uses plain `pnpm install` (NOT --frozen-lockfile): the agent scaffold ships
// no lockfile. Org-level R2_* secrets (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
// R2_ACCOUNT_ID) are inherited from the store org — public repos get them
// (console/notes already deploy this way). Contains no APPNAME placeholder.
function deployWorkflow(config: StoreConfig): string {
  return `name: Deploy to R2

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-\${{ github.repository }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install
        run: pnpm install --no-frozen-lockfile
${
  config.store === "apps"
    ? `      - name: Resolve build target
        id: target
        run: npx @freeappstore/cli build-target --app-id "\${GITHUB_REPOSITORY##*/}" --github-output
      - name: Build
        env:
          BUILD_COMMAND: \${{ steps.target.outputs.build-command }}
        run: bash -e -c "$BUILD_COMMAND"
      - name: Verify build output
        run: npx @freeappstore/cli build-target --artifact --app-id "\${GITHUB_REPOSITORY##*/}"
`
    : `\
      - name: Build
        run: pnpm build
      - name: Verify build output
        run: |
          test -d ./web/dist || { echo "::error::No build output at web/dist"; exit 1; }
          test -n "$(ls -A ./web/dist)" || { echo "::error::web/dist is empty"; exit 1; }
`
}\
      - name: Upload to R2
        env:
${config.store === "apps" ? `          OUTPUT_PATH: \${{ steps.target.outputs.output-path }}\n` : ""}\
          AWS_ACCESS_KEY_ID: \${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          R2_ACCOUNT_ID: \${{ secrets.R2_ACCOUNT_ID }}
        run: |
          aws s3 sync ${config.store === "apps" ? '"$OUTPUT_PATH"' : "./web/dist"} "s3://${config.r2Bucket}/${config.nounPlural}/\${GITHUB_REPOSITORY##*/}/" \\
            --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \\
            --delete \\
            --no-progress
          echo "Deployed ${config.nounPlural}/\${GITHUB_REPOSITORY##*/} from \${GITHUB_SHA::7} to R2"
`;
}

// ── Public API ──

const CONNECTED_DRAFT = `import { useEffect, useRef } from 'react';
import { useConnectedKvDraft } from '@freeappstore/sdk/hooks';
import { SignInButton } from '@freeappstore/sdk/ui';
import type { FreeAppStore } from '@freeappstore/sdk';
import { pwa } from '../fas-capabilities/pwa';

/** Keep the sign-in gate on this private-data feature, not on public app screens. */
export function ConnectedDraft({ app: fas }: { app: FreeAppStore }) {
  const draft = useConnectedKvDraft(fas, 'private-draft', '');
  const busy = useRef(false);
  busy.current = draft.dirty || draft.saving;
  useEffect(() => pwa.addBusyGuard(() => busy.current), []);

  if (!draft.user) {
    return (
      <section aria-labelledby="draft-title">
        <h2 id="draft-title">Private draft</h2>
        <p>Sign in to load or save your private draft. Public parts of the app remain available.</p>
        <SignInButton app={fas} />
      </section>
    );
  }

  return (
    <section aria-labelledby="draft-title">
      <h2 id="draft-title">Private draft</h2>
      {draft.loading ? <p role="status">Loading your draft…</p> : null}
      {draft.error ? (
        <p role="alert">
          {draft.error}{' '}
          <button type="button" onClick={draft.retry}>
            Retry
          </button>
        </p>
      ) : null}
      <label htmlFor="private-draft">Your notes</label>
      <textarea
        id="private-draft"
        style={{ display: 'block', boxSizing: 'border-box', width: '100%', minWidth: 0, maxWidth: '100%', resize: 'vertical' }}
        value={draft.draft}
        onChange={(event) => draft.setDraft(event.currentTarget.value)}
      />
      <button
        type="button"
        disabled={!draft.dirty || draft.saving}
        onClick={() => void draft.save()}
      >
        {draft.saving ? 'Saving…' : 'Save'}
      </button>
      {draft.dirty ? <span>Unsaved changes</span> : null}
    </section>
  );
}
`;

export function getArchetypeFiles(archetype: AppArchetype): Record<string, string> {
  return APP_ARCHETYPE_FILES[archetype];
}

export function getTemplateFiles(config: StoreConfig, archetype?: AppArchetype, preset: AppPreset = "standalone"): Record<string, string> {
  const appArchetypeFiles = config.store === "games" ? {} : getArchetypeFiles(archetype ?? "generic");
  const capabilities = config.store === "apps" ? resolveStarterPreset(preset) : [];
  const foundationFiles = { ...SHARED_FILES, ...APP_FILES };
  const capabilityPlan = planCapabilityChanges(capabilities, foundationFiles, {}, () => false);
  const capabilityFiles = capabilityPlan.writes;
  const files: Record<string, string> = {
    ...SHARED_FILES,
    ...(config.store === "games" ? GAME_FILES : APP_FILES),
    ...(config.store === "apps"
      ? {
          "web/package.json": SHARED_FILES["web/package.json"]
            .replace('"^0.14.30"', '"^0.16.15"')
            .replace('"vite": "^6"', '"vite": "^6",\n    "vite-plugin-pwa": "^1.0"'),
          "web/vite.config.ts": `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from '@freeappstore/sdk/pwa-config';
export default defineConfig({ plugins: [react(), tailwindcss(), VitePWA(pwaOptions())] });`,
          "web/src/pwa.ts": `// Compatibility path: the canonical app-owned controller lives in fas-capabilities/pwa.ts.
export { pwa } from './fas-capabilities/pwa';
`,
          "web/src/main.tsx": `import './fas-capabilities/pwa';\n${SHARED_FILES["web/src/main.tsx"]}`,
          "web/public/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="64" fill="#2563eb"/><path d="M160 160h192v48H208v48h120v48H208v48h-48z" fill="white"/></svg>`,
          "web/public/manifest.json": JSON.stringify(
            {
              ...JSON.parse(APP_FILES["web/public/manifest.json"]),
              id: "/",
              scope: "/",
              min_viewport_width: 320,
              icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
            },
            null,
            2,
          ),
          "web/index.html": APP_FILES["web/index.html"].replace("initial-scale=1.0", "initial-scale=1.0, viewport-fit=cover"),
          "web/src/index.css": `${APP_FILES["web/src/index.css"]}
html { overflow-wrap: anywhere; }
body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
img, video, canvas { max-width: 100%; }
`,
          "fas.json": JSON.stringify(
            { appId: "APPID", applicationRoot: "web", outputPath: "web/dist", buildCommand: "pnpm build" },
            null,
            2,
          ),
          ...capabilityFiles,
        }
      : {}),
    ...appArchetypeFiles,
    ".github/workflows/deploy.yml": deployWorkflow(config),
  };

  if (config.store === "apps" && preset === "connected") {
    files["web/src/App.tsx"] = files["web/src/App.tsx"]
      .replace("import { initApp }", 'import { ConnectedDraft } from "./components/ConnectedDraft";\nimport { initApp }')
      .replace(
        '  return <PageHeader title="Welcome to APPNAME" description="Edit web/src/App.tsx to get started." />;',
        '  return <><PageHeader title="Welcome to APPNAME" description="Editable app-owned starter screen." /><ConnectedDraft app={fas} /></>;',
      );
    files["web/src/components/ConnectedDraft.tsx"] = CONNECTED_DRAFT;
    files["web/package.json"] = files["web/package.json"].replace('"^0.16.15"', '"^0.16.26"');
  }

  return files;
}

/** Builder-side equivalent of `fas add`: preview or apply canonical capabilities to an existing virtual app. */
export function applyCapabilitiesToTemplate(
  currentFiles: Record<string, string>,
  ids: string[],
  dryRun = false,
  update = false,
): Promise<{ files: Record<string, string>; changes: string[]; prerequisites: string[] }> {
  return applyCapabilitiesToTemplateAsync(currentFiles, ids, dryRun, update);
}

async function applyCapabilitiesToTemplateAsync(
  currentFiles: Record<string, string>,
  ids: string[],
  dryRun: boolean,
  update: boolean,
): Promise<{ files: Record<string, string>; changes: string[]; prerequisites: string[] }> {
  const capabilities = resolveCapabilities(ids);
  const rootPackageText = currentFiles["package.json"];
  if (!rootPackageText) throw new Error("Builder app is missing package.json; no capability files changed.");
  const prerequisiteResult = checkCapabilityPackagePrerequisites(capabilities, rootPackageText, currentFiles["web/package.json"], {
    validRange,
    minVersion,
    subset,
  });
  if (prerequisiteResult.errors.length && !dryRun)
    throw new Error(`INCOMPLETE: package prerequisites unmet; no files changed.\n${prerequisiteResult.errors.join("\n")}`);
  if (prerequisiteResult.errors.length) {
    return {
      files: currentFiles,
      changes: ["INCOMPLETE: package prerequisites unmet; no files changed.", ...prerequisiteResult.checked, ...prerequisiteResult.errors],
      prerequisites: prerequisiteResult.errors,
    };
  }

  type CapabilityManifest = {
    schemaVersion: 1;
    capabilities: Record<string, { version: string; files: Record<string, string>; metadata?: Record<string, string> }>;
  };
  const manifestPath = ".fas-capabilities.json";
  const manifestText = currentFiles[manifestPath];
  const manifest: CapabilityManifest = manifestText ? JSON.parse(manifestText) : { schemaVersion: 1, capabilities: {} };
  if (manifest.schemaVersion !== 1 || !manifest.capabilities || typeof manifest.capabilities !== "object")
    throw new Error("Unsupported capability manifest; no files changed.");
  const owners: Record<string, string> = {};
  for (const [owner, owned] of Object.entries(manifest.capabilities)) {
    for (const path of Object.keys(owned.files)) owners[path] = owner;
  }
  const digests = new Map<string, string>();
  const digest = async (text: string) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  for (const [path, owner] of Object.entries(owners)) {
    const current = currentFiles[path];
    const expected = manifest.capabilities[owner]?.files[path];
    if (current !== undefined && expected !== undefined) digests.set(path, await digest(current));
  }
  const plan = planCapabilityChanges(capabilities, currentFiles, owners, (path) => {
    const owner = owners[path];
    return !!owner && digests.get(path) === manifest.capabilities[owner]?.files[path];
  });
  for (const capability of capabilities) {
    const old = manifest.capabilities[capability.id];
    if (old && old.version !== capability.version && !update)
      throw new Error(`${capability.id}: installed ${old.version}; review a dry-run with update before updating to ${capability.version}.`);
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(capability.files)) files[path] = await digest(content);
    manifest.capabilities[capability.id] = {
      version: capability.version,
      files: { ...old?.files, ...files },
      ...(capability.metadata ? { metadata: capability.metadata } : {}),
    };
  }
  const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestChanged = nextManifest !== manifestText;
  const files = dryRun ? currentFiles : { ...currentFiles, ...plan.writes, ...(manifestChanged ? { [manifestPath]: nextManifest } : {}) };
  const changes = dryRun
    ? [...prerequisiteResult.checked, ...plan.changes, ...(manifestChanged ? [`UPDATE ${manifestPath}`] : [])]
    : [...plan.changes, ...(manifestChanged ? [`UPDATE ${manifestPath}`] : [])];
  return {
    files,
    changes: changes.length ? changes : ["No changes."],
    prerequisites: prerequisiteResult.errors,
  };
}

export function substituteAppName(files: Record<string, string>, appId: string, displayName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    out[path] = content.replace(/APPNAME/g, path.includes("package.json") || path.includes("pnpm-workspace") ? appId : displayName);
    if (path === "web/index.html" || path === "fas.json") out[path] = out[path].replace(/APPID/g, appId);
  }
  // Fix package.json files to use the ID (lowercase, no spaces)
  if (out["package.json"]) {
    out["package.json"] = out["package.json"].replace(new RegExp(displayName, "g"), appId);
  }
  if (out["web/package.json"]) {
    out["web/package.json"] = out["web/package.json"].replace(new RegExp(displayName, "g"), appId);
  }
  return out;
}

// ── System prompts ──

const APP_SYSTEM_PROMPT = `You are the FreeAppStore AI agent. You build free, high-quality web apps that deploy to freeappstore.online.

## Your Role
Users describe an app idea and you build it. You write TypeScript + React code, following the FreeAppStore brand and conventions exactly.

## Supported foundation
- TypeScript, React 19, Vite 6, Tailwind CSS 4.1, @freeappstore/sdk
- Choose device-local, private-account, public-shared or room storage according to requirements (below).
- A cached PWA shell can open offline; account sync, proxy APIs and rooms require connectivity. Show honest offline and failure states.

## The app shell (supported default)
web/src/App.tsx already wraps the app in \`<Shell>\` from "@freeappstore/sdk/ui". Keep that
root unless the user asks for a custom frame. Shell provides:
- The topbar: app name only, text size, theme toggle while signed out, and a compact avatar
  that opens the profile page in both auth states. Do not mount SignInButton or ProfileMenu
  in the header. There is no store logo and no attribution bar.
- The main navigation from the \`nav\` prop: a <nav aria-label="Main"> with the current screen
  highlighted, collapsing to a menu on phones. Declare each primary screen in \`NAV\` (label + href, and
  a \`title\` for the browser tab); switch screens on \`path\` in App. Detail routes do not need a NAV entry.
- An error boundary (a crashing screen shows "Try again", not a white page), a loading spinner
  for React.lazy screens, an offline banner, and a skip link.
- Feedback: \`const toast = useToast(); toast.show("Saved", { variant: "success" })\`.
Start each primary screen with \`<PageHeader title="…" />\` (its one h1, and the focus target after
navigation). \`useDocumentTitle("…")\` sets a screen's tab title when the nav title isn't enough.
All of these import from "@freeappstore/sdk/ui". A custom frame, sidebar, or bottom nav is allowed
under the composable starter contract (docs/composable-starter-contract.md) when it keeps
accessibility, platform identity, and security. Preserve labelled navigation, keyboard access, visible focus, a skip link or equivalent, page zoom and 44px touch targets. Keep a reachable profile route in both auth states, shared theme/text preferences and loading/error feedback. Do not add a second account menu.
FreeAppStore is free: there is no paid tier,
subscription or upgrade screen. Only pass \`requireAuth\` to Shell if the whole app needs sign-in.

## Brand Rules (mandatory)
- Fonts: Manrope (body) + Fraunces (headings; index.css already applies it to h1-h3)
- CSS variables: --paper, --ink, --muted, --line, --panel, --accent, etc. (defined in index.css)
- Dark mode via :root[data-theme="dark"] in index.css (the SDK sets it from the system or the
  Shell's theme toggle); just use the CSS variables
- Border radius: 1.25rem for cards, 0.75rem for buttons
- The topbar shows the app name only. Do not add a store logo or attribution bar. Footer is optional and is not part of Shell

## Privacy Rules (mandatory)
- ZERO analytics, tracking, cookies, or third-party scripts (except Google Fonts which is in the template)
- NO payments and NO ads. FreeAppStore apps are free forever: no checkout or payment SDKs (Stripe, PayPal,
  Paddle, Lemon Squeezy, Gumroad), Payment Request API, Apple Pay, Google Pay or payment links, and no ad
  networks or ad SDKs (AdSense, Ad Manager, AdMob / H5 Games Ads, Carbon, Poki or CrazyGames ads). No tip
  jars, upgrade screens or paywalls either. run_compliance_check fails payment and ad code, and deploy and
  push_update refuse to ship it.
- Default to device-local persistence without sign-in when it meets requirements. Use private-account KV for private cross-device data; collections and room broadcasts are not private storage.
- NEVER add an API-key input or ask the user to paste/enter an API key. End users never supply keys on this platform — developer API keys are configured once in the platform itself, not in the app. If a feature needs a third-party API key and cannot work without one, build the rest of the app and tell the user that API access is configured at the platform level (server-side key injection is coming via the SDK proxy), not inside the app.

## How You Work
1. Start from the existing scaffold. Preserve app-owned screens, domain models, navigation, edited configuration and user data; do not regenerate them wholesale.
2. Edit app-owned code in web/src/, including App.tsx, screens, components and index.css as needed. Preserve SDK Tailwind sources and token mappings.
3. Necessary capability-owned infrastructure changes use the safe workflow below, not direct writes to locked files.
4. Shell is the supported default frame. A custom frame is allowed when it meets the accessibility, account, identity and security obligations above.
5. With Shell, add one NAV entry per primary screen; detail routes stay off the nav. Custom navigation must be labelled and keyboard accessible.
6. BEFORE deploying, run run_compliance_check to validate the project passes all platform rules. Fix any failures.
7. After compliance passes, IMMEDIATELY deploy — do NOT ask "ready to deploy?". Just call the deploy tool right away. Pick a sensible app ID, name, category, icon, and description based on what was built.
8. Never wait for user confirmation to deploy. Build -> compliance -> deploy. That's the flow.
9. After the first deploy, use push_update to push changes (not deploy again).
10. After pushing, use check_deploy_status or get_build_logs to monitor the build.
11. If the build fails, use get_build_logs to see the error, fix the code, and push_update again.
12. Other tools: list_deployed_apps, get_ci_results, get_audit_results, fetch_url, search_files.

## Code Quality
- Write clean, idiomatic TypeScript + React
- Use Tailwind classes for styling, referencing CSS variables where appropriate
- Use React hooks (useState, useEffect, useCallback, useMemo) appropriately
- Use maintained persistence helpers with validation and explicit failure handling (below); report saved only after a successful write.
- Handle empty states gracefully
- Make it responsive (mobile-first)
- Keep bundle size small — no unnecessary dependencies (the template has React + Tailwind + @freeappstore/sdk only)

## Voice Input
User messages may come from voice dictation and contain transcription errors, partial sentences,
or misheard words. Always interpret the user's intent — don't get confused by typos, wrong words,
or garbled phrasing. If you're unsure what they meant, ask for clarification.

## Security Rules (enforced server-side — you cannot bypass these)
- You can ONLY deploy and push_update to the app created in THIS session
- You CANNOT modify, deploy to, or push code to apps created by other users
- Each session = one app. To build a different app, the user creates a new project
- App IDs must be lowercase, numbers, hyphens only. Cannot start with "free" or "pro"
- If a user asks you to modify someone else's app, refuse and explain why

## Third-party APIs (weather, flights, sports, etc.)
The app has no backend, but it CAN call third-party APIs through the platform's secret-injecting
proxy. The developer's API key is configured once in the platform and injected server-side — the
**end user never enters a key**. Build it like this:
1. "@freeappstore/sdk" is already a dependency and App.tsx already has
   \`const fas = initApp({ appId: "APPID" });\` — keep the literal string "APPID"; it is replaced
   with this app's real id at deploy. Do NOT guess the id (the SDK appId MUST equal the deployed id
   or the proxy will 404).
2. Call the API via the proxy — first path segment is the host, the rest is path+query:
   \`const res = await fas.proxy.fetch("api.openweathermap.org/data/2.5/weather?q=London");\`
   The platform injects the key, matches the allowlist, and forwards server-side.
3. The proxy requires the visitor to be signed in. Use \`useAuth\` from "@freeappstore/sdk/hooks"
   and gate the API features behind a "Sign in with GitHub" button (\`fas.auth.signIn()\`). Signing
   in is one tap and does NOT involve a key.
4. Call the \`register_api\` tool once per API (host + secretName + injectKind + injectName) so the
   needed key is recorded in fas.json. Tell the user: after publishing, open the app's "API Keys"
   page in VibeCode and add that key once.
5. NEVER add an API-key input field or ask the user to paste a key. That is wrong on this platform.

## Saved data and storage ownership
Choose storage by product requirements, not layout or preset:
- Device-local: use validated helpers from "@freeappstore/sdk/persist": getPreference/setPreference for namespaced preferences and openStore/putRecord for IndexedDB records. localStorage is per-device, cleared with browser data and is not a backup. Check the returned ok/reason; surface quota, unavailable, corrupt and validation failures without silently resetting data or claiming success. Use "@freeappstore/sdk/backup" for app-chosen export/import.
- Private-account: fas.kv stores the signed-in user's keys for this app. Share the app-owned fas instance via props; never initialize a second instance in a feature, because profile sign-out must revoke its access too. Keep Home/About public; gate private data rather than Shell. Use useAuth from "@freeappstore/sdk/hooks" and SDK sign-in UI.
  await fas.kv.set("notes", notesArray); await fas.kv.get("notes"); fas.kv.list({ prefix }); fas.kv.delete(key).
  Free limits: 64KB per value, 1MB per user, 100 keys. Handle auth/network failures and account changes; stale responses from an earlier account must not overwrite current state.
- Public-shared: fas.collections has public reads and owner writes. Never store private data here or describe hidden UI as confidentiality.
- Room fan-out: fas.rooms is ephemeral broadcast, not durable persistence, a private room or an access-control list. Never send secrets or private account records.
Use installed cloud-data capability examples for validated, race-safe connected wiring. Capability installation and updates must never delete user records.

## Capability configuration (supported safe workflow)
Use the builder session capabilities API (POST /session/:id/capabilities), or fas add in a local checkout, for first-party capability installation/configuration. Preview with dryRun: true (CLI: --dry-run), review the plan and prerequisites, then apply. Resolve reported conflicts without overwriting edited generated files; updates require an explicit update plan. This workflow may change capability-owned files/configuration and dependencies. It does not authorize arbitrary package installation or bypass write_file locks. If the current chat tools cannot invoke the session API, explain the required capability action rather than pretending it ran. Preserve app-owned configuration and data.

## Infrastructure locked to direct writes
These files are managed by the platform and write_file will reject changes to them:
- package.json, web/package.json (dependencies + infra config)
- pnpm-workspace.yaml, web/vite.config.ts
- web/tsconfig.json, web/tsconfig.app.json, web/tsconfig.node.json
- web/src/main.tsx, .gitignore, LICENSE

Preserve .github/workflows/deploy.yml deployment and compliance checks when configuration changes are needed.
Do not write these directly with write_file. Use the capability workflow for supported infrastructure changes; edit app-owned screens and styles normally.

## Important
- Do not add arbitrary npm dependencies; supported capability changes use the safe workflow above. The template already has React, Tailwind and "@freeappstore/sdk"
  (the Shell, UI components, sign-in, cloud storage and the API proxy).
- Do NOT add analytics, tracking, payments, ads, or any third-party scripts.
- Do NOT build your own backend/server. For external data, use the platform proxy (above), not a
  custom backend.
- Always use the write_file tool to create/edit files. Show the user what you're building.
- When you deploy, all APPNAME placeholders in template files must be replaced with the actual app name.
`;

const GAME_SYSTEM_PROMPT = `You are the FreeGameStore AI agent. You build free, high-quality web games that deploy to freegamestore.online.

## Your Role
Users describe a game idea and you build it. You write TypeScript + React code, following the FreeGameStore brand and conventions exactly.

## Tech Stack (mandatory)
- TypeScript, React 19, Vite 6, Tailwind CSS 4.1
- All game state in memory (no backend, no server, no database)
- High scores / progress in localStorage
- Must work offline after first load (PWA)

## Brand Rules (mandatory)
- Fonts: Manrope (body/UI) + Fraunces (display/headings only)
- CSS variables: --paper, --panel, --ink, --muted, --accent, --line (defined in index.css). Use --paper for the canvas background; never --bg, --surface or --border.
- Dark theme only (games always use dark background #0f0f0f)
- Use the GameShell component as the root layout. Build your game inside <GameShell>.
- GameShell provides a 44px top bar + full-height game area
- Link to freegamestore.online is in the GameShell header (already included)

## Game-Specific Rules (mandatory)
- NO splash screens or loading screens — game must be immediately playable
- Audio muted by default — user must tap/click to unmute
- All touch targets minimum 44px (buttons, controls, interactive areas)
- Body overflow: hidden (already set in index.css). No scrolling.
- The game canvas/area must fill the remaining viewport below the 44px topbar
- Support both mouse/keyboard AND touch input
- Responsive: adapt layout for portrait mobile, landscape mobile, and desktop
- Use requestAnimationFrame for game loops, not setInterval
- Keep frame rate smooth — avoid heavy computation in the render loop

## Game Templates Reference
When building games, follow these patterns based on game type:
- Canvas games (platformers, shooters, physics): Use HTML5 Canvas with 2D context, requestAnimationFrame loop
- Grid games (puzzle, board, match-3): Use CSS Grid or flexbox, state in a 2D array
- Card games (solitaire, memory, poker): Use flexbox layout, drag-and-drop or tap interactions
- 3D games: Use Three.js (add as dependency if needed)

## Privacy Rules (mandatory)
- ZERO analytics, tracking, cookies, or third-party scripts (except Google Fonts which is in the template)
- NO payments and NO ads. FreeGameStore games are free forever: no checkout or payment SDKs (Stripe, PayPal,
  Paddle, Lemon Squeezy, Gumroad), Payment Request API, Apple Pay, Google Pay or payment links, and no ad
  networks or ad SDKs (AdSense, Ad Manager, AdMob / H5 Games Ads, Carbon, Poki or CrazyGames ads). No tip
  jars, upgrade screens or paywalls either. run_compliance_check fails payment and ad code, and deploy and
  push_update refuse to ship it.
- High scores in localStorage only
- No accounts, no sign-in required
- NEVER add an API-key input or ask the user to paste/enter an API key. End users never supply keys on this platform — developer API keys are configured once in the platform itself, not in the app. If a feature needs a third-party API key and cannot work without one, build the rest of the app and tell the user that API access is configured at the platform level (server-side key injection is coming via the SDK proxy), not inside the app.

## How You Work
1. The session starts with template files already loaded. Use read_file to see them.
2. Build the game by writing/editing files with write_file. Focus on web/src/App.tsx and add components in web/src/components/.
3. Keep the GameShell component as the root layout. Build your game's UI inside it.
4. BEFORE deploying, run run_compliance_check to validate the project passes all platform rules. Fix any failures.
5. After compliance passes, IMMEDIATELY deploy — do NOT ask "ready to deploy?". Just call the deploy tool right away. Pick a sensible game ID, name, category, icon, and description based on what was built.
6. Never wait for user confirmation to deploy. Build -> compliance -> deploy. That's the flow.
7. After the first deploy, use push_update to push changes (not deploy again).
8. After pushing, use check_deploy_status or get_build_logs to monitor the build.
9. If the build fails, use get_build_logs to see the error, fix the code, and push_update again.
10. Use get_ci_results to check if GitHub Actions compliance checks passed.
11. Use get_audit_results to see the quality auditor's findings and fix any issues.
12. Use list_deployed_games to see all games on the platform.
13. Use fetch_url to check if a deployed game is live or read remote content.
14. Use search_files to find patterns across the project (useful for debugging).

## Code Quality
- Write clean, idiomatic TypeScript + React
- Use Tailwind classes for UI styling, referencing CSS variables where appropriate
- For canvas games: keep game logic separate from rendering
- Use React hooks (useState, useEffect, useCallback, useRef, useMemo) appropriately
- Store high scores in localStorage with a namespaced key (e.g. "gamename_highscore")
- Handle empty states gracefully
- Make it responsive (mobile-first, touch-first)
- Keep bundle size small — no unnecessary dependencies (the template has React + Tailwind only)

## Voice Input
User messages may come from voice dictation and contain transcription errors, partial sentences,
or misheard words. Always interpret the user's intent — don't get confused by typos, wrong words,
or garbled phrasing. If you're unsure what they meant, ask for clarification.

## Security Rules (enforced server-side — you cannot bypass these)
- You can ONLY deploy and push_update to the game created in THIS session
- You CANNOT modify, deploy to, or push code to games created by other users
- Each session = one game. To build a different game, the user creates a new project
- Game IDs must be lowercase, numbers, hyphens only. Cannot start with "free" or "pro"
- If a user asks you to modify someone else's game, refuse and explain why

## Locked files (cannot be modified)
These files are managed by the platform and write_file will reject changes to them:
- package.json, web/package.json (dependencies + infra config)
- pnpm-workspace.yaml, web/vite.config.ts
- web/tsconfig.json, web/tsconfig.app.json, web/tsconfig.node.json
- web/src/main.tsx, .gitignore, LICENSE
- .github/workflows/deploy.yml (CI/CD)

Do NOT attempt to edit these. Build your game entirely in web/src/ (App.tsx + components/).

## Important
- Do NOT add any npm dependencies beyond what's in the template unless absolutely necessary (e.g. Three.js for 3D games). Build everything with React + Tailwind + Canvas API.
- Do NOT add analytics, tracking, payments, ads, or any third-party scripts.
- Do NOT create a backend or API — this is a static game.
- Always use the write_file tool to create/edit files. Show the user what you're building.
- When you deploy, all APPNAME placeholders in template files must be replaced with the actual game name.
`;

export function getSystemPrompt(config: StoreConfig): string {
  return config.store === "games" ? GAME_SYSTEM_PROMPT : APP_SYSTEM_PROMPT;
}

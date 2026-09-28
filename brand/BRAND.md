# FreeAppStore Brand Guidelines

## Mission

FreeAppStore is an open platform for free, high-quality web applications — no ads, no paywalls, no subscriptions, no catch. Everything we build and host is 100% free, forever. Every app is private, offline-capable, and works on any device. One app per category — no duplicates, no fragmentation.

## Platform Rules

1. **One app per category.** There will never be two chess apps, two audiobook readers, or two calendars. One free, one pro — that's it.
2. **Free means free.** No freemium, no ads, no plans, no paywalls. Ever.
3. **Real apps, not websites.** PWA-capable, offline-first, installable to home screen.
4. **Private by default.** No tracking, no analytics, no accounts required.
5. **Open source.** Every free app is MIT-licensed and open on GitHub.

## Logo

### Wordmark

- **FreeAppStore** — written as one word with "App" highlighted in accent blue
- **ProAppStore** — written as one word with "App" highlighted in accent purple
- Font: System bold (matches body font weight 800)
- No icon/symbol — the wordmark IS the brand

### Usage

```
Free[App]Store    — accent blue (#2563eb)
Pro[App]Store     — accent purple (#7c3aed)
```

- Always one word, PascalCase
- Never "Free App Store" (three words)
- Never all-caps "FREEAPPSTORE"

## Colors

### Platform Colors (landing site, store pages)

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `--accent` | `#2563eb` | `#60a5fa` | Primary actions, links, active states |
| `--pro` | `#7c3aed` | `#a78bfa` | Pro references, upgrade links |
| `--ink` | `#1a1a1a` | `#f0f0f0` | Body text |
| `--muted` | `#6b6b6b` | `#999999` | Secondary text |
| `--surface` | `#ffffff` | `#1a1a1a` | Card backgrounds |
| `--bg` | `#fafaf9` | `#0f0f0f` | Page background |
| `--border` | `#e5e5e5` | `#2a2a2a` | Borders, dividers |

### App Colors (within individual apps)

Each app gets ONE accent color. All other UI chrome uses the shared neutral palette.

| App | Accent (light) | Accent (dark) | Rationale |
|-----|----------------|---------------|-----------|
| Chess | `#5b7db1` | `#7da3d4` | Calm blue — strategic |
| Language | `#da5b37` | `#e8845f` | Warm terracotta — cultural |
| Math | `#4d70dc` | `#7b9aef` | Confident blue — precise |
| Music | `#6ECE9E` | `#8ae4b8` | Teal green — creative |
| Puzzle | `#ff8a54` | `#ffab7a` | Energetic orange — playful |
| Quiz | `#d86f4d` | `#e89070` | Warm orange — engaging |
| Books | `#c08552` | `#d4a574` | Golden brown — literary |

### Shared UI Palette (all apps must use)

```css
--paper: #fefdfb / #141413        /* Page background */
--ink: #1a1917 / #f2f0ed          /* Primary text */
--muted: #8a8780 / #7a7770       /* Secondary text */
--line: #e8e5e0 / #2a2825        /* Borders */
--line-strong: #d4d0ca / #3a3835 /* Strong borders */
--panel: #f5f3f0 / #1e1d1b       /* Panel backgrounds */
--glass: rgba(255,253,251,0.7) / rgba(20,20,19,0.7) /* Frosted glass */

--success: #22c55e / #4ade80
--warning: #f59e0b / #fbbf24
--error: #ef4444 / #f87171

--shadow-soft: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.03)
--shadow-card: 0 2px 8px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)
```

## Typography

### Fonts

| Role | Family | Weight | Usage |
|------|--------|--------|-------|
| Body | **Manrope** | 400, 500, 600, 700 | All UI text, labels, body copy |
| Display | **Fraunces** | 700, 800 | Headlines, card titles, hero text |

Load from Google Fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,700;9..144,800&display=swap" rel="stylesheet">
```

### Scale

```css
--text-xs: 0.65rem    /* Labels, badges */
--text-sm: 0.85rem    /* Secondary text */
--text-base: 1rem     /* Body text */
--text-lg: 1.2rem     /* Subheadings */
--text-xl: 1.5rem     /* Section titles */
--text-2xl: 2rem      /* Page titles */
--text-hero: clamp(2.2rem, 5vw, 3.5rem) /* Hero headlines */
```

### Rules

- Body text: Manrope 400, 1.6 line-height
- UI labels: Manrope 600-700, uppercase with `letter-spacing: 0.08em` for small labels
- Card titles: Fraunces 700
- Page headers: Fraunces 800
- Never use more than 2 font weights on a single screen

## Layout

### App Shell

All apps use the SDK's `Shell` (`@freeappstore/sdk/ui`), so every app has the same frame.
Apps don't draw their own header, sidebar or dock. See
[Build your app on the Shell](../docs/getting-started.md#build-your-app-on-the-shell).

```
Desktop (≥640px):
┌──────────────────────────────────────────────────────┐
│ Free  App name   Home  Notes  Settings    Aa  ◐  (•) │  ← topbar: <header> + <nav aria-label="Main">
├──────────────────────────────────────────────────────┤
│  Page title                                          │  ← PageHeader (the screen's h1)
│                                                      │
│  Screen content                                      │  ← <main id="main">
│                                                      │
└──────────────────────────────────────────────────────┘

Mobile (<640px):
┌──────────────────────────┐
│ Free  App name  ☰  Aa (•) │  ← nav collapses to a menu button
├──────────────────────────┤
│  Page title              │
│                          │
│  Screen content          │
│                          │
└──────────────────────────┘
```

### Spacing

Use Tailwind spacing scale. Key values:
- Component padding: `1.25rem` (card), `1.5rem` (section)
- Grid gaps: `1.25rem`
- Page margins: `1.5rem` mobile, `2rem` desktop
- Border radius: `1.25rem` (cards), `0.75rem` (buttons), `9999px` (pills)

### Breakpoints

```css
sm: 640px   /* Large phones */
md: 768px   /* Tablets */
lg: 1024px  /* Desktop */
xl: 1280px  /* Wide desktop */
```

## Components

### Navigation — Desktop Sidebar

- Fixed left, 17rem wide
- Glass background with blur
- Contains: app logo/name, navigation items, settings/tools
- Rounded corners (`border-radius: 1.5rem`)
- Subtle border (`var(--line)`)

### Navigation — Mobile Dock

- Fixed bottom, full width
- Backdrop blur + semi-transparent background
- 2-4 tab buttons with icons
- Safe area padding for notched devices
- Active tab: accent color + subtle background

### Cards

- Background: `var(--surface)` or `var(--panel)`
- Border: `1px solid var(--line)`
- Border radius: `1.25rem`
- Padding: `1.5rem`
- Hover: lift (`translateY(-2px)`) + shadow increase
- Transition: `200ms ease`

### Buttons

- Primary: accent background, white text, rounded (`0.75rem`)
- Secondary: transparent background, accent text, accent border
- Ghost: no background, muted text
- Active state: `scale(0.985)`
- Transition: `160ms ease`

### Inputs

- Background: `var(--panel)`
- Border: `1px solid var(--line)`
- Border radius: `0.75rem`
- Focus: `2px` outline in sky blue
- Padding: `0.75rem 1rem`

## Icons

- Style: Outlined, 1.5px stroke
- Size: 20px default, 16px small, 24px large
- Source: Use inline SVG or Unicode symbols
- No icon library dependency — keep apps lightweight

## Motion

```css
--transition-fast: 120ms ease
--transition-base: 200ms ease
--transition-slow: 300ms ease
```

- Button press: `scale(0.985)` over 120ms
- Card hover: `translateY(-2px)` over 200ms
- Panel slide: 300ms ease
- No motion: respect `prefers-reduced-motion`

## Dark Mode

- Triggered by `prefers-color-scheme: dark`
- All colors defined as CSS custom properties with light/dark values
- No toggle in-app (follows system preference)
- Surfaces get darker, text gets lighter, accents stay vibrant

## PWA Requirements

Every app must include:
- `manifest.json` with app name, icons, theme color
- Service worker for offline support
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<meta name="mobile-web-app-capable" content="yes">`
- Safe area inset handling (`env(safe-area-inset-*)`)
- Touch-action: manipulation on interactive elements

## File Structure Convention

```
app-name/
├── package.json
├── pnpm-workspace.yaml
├── web/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── public/
│   │   └── manifest.json
│   └── src/
│       ├── main.tsx
│       ├── index.css          (Tailwind + custom properties)
│       ├── App.tsx
│       ├── components/
│       ├── hooks/
│       ├── services/          (data, logic)
│       └── types.ts
└── .gitignore
```

## Technology Stack

| Layer | Choice | Version |
|-------|--------|---------|
| Language | TypeScript | ^5.7 |
| Framework | React | ^19.0 |
| Bundler | Vite | ^6.0 |
| Styling | Tailwind CSS | ^4.1 |
| Hosting | Cloudflare Pages | — |
| Package Manager | pnpm | ^10.30 |

## Naming Conventions

### App Names

- GitHub repo: `freebooks`, `freechess`, `freelang`, etc.
- Package name: `freebooksapp`, `freechessapp`, etc.
- Display name: `Books`, `Chess`, `Language`, etc.
- Subdomain: `books.freeappstore.online`, `chess.freeappstore.online`

### Code

- Components: PascalCase (`AudioControls.tsx`)
- Hooks: camelCase with `use` prefix (`useTTS.ts`)
- Services/data: camelCase (`catalog.ts`, `problems.ts`)
- Types: PascalCase for types/interfaces, in `types.ts` or co-located
- CSS variables: kebab-case (`--accent-gradient`)

## Quality Criteria for New Apps

Before an app is listed on FreeAppStore, it must meet ALL of these:

- [ ] Truly free forever — no monetization path in the free version
- [ ] Responsive — works on 320px to 2560px screens
- [ ] Offline-capable — core features work without internet
- [ ] PWA-installable — manifest, service worker, proper meta tags
- [ ] Private — zero data leaves the device
- [ ] Follows brand guidelines — fonts, colors, layout, components
- [ ] Open source — MIT license, public repo on freeappstore-online org
- [ ] Unique category — no existing app serves the same purpose
- [ ] Performance — loads in <2s on 3G, <100KB JS gzipped for core
- [ ] Accessible — keyboard navigable, proper ARIA labels, contrast ratios

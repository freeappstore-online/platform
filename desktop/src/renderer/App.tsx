import {
  Badge,
  ConfirmDialog,
  EmptyState,
  ProgressBar,
  SearchInput,
  TextSizeToggle,
  ThemeToggle,
} from '@freeappstore/sdk/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { encode } from 'uqr';
import type { PairCode } from '../main/device.js';
import type {
  ClientId,
  ClientStatus,
  ContributeMode,
  ContributeWhen,
  DesktopContribute,
  DesktopState,
  HistoryItem,
  OpenApp,
  RegistryApp,
} from './desktop.js';

type Page = 'home' | 'store' | 'contribute' | 'activity' | 'account' | 'whats-new';
const PAGES: { id: Page; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'store', label: 'Store' },
  { id: 'contribute', label: 'Contribute' },
  { id: 'activity', label: 'Activity' },
];

const desktop = window.fasDesktop;

const button =
  'inline-flex items-center justify-center gap-2 rounded-card px-4 py-2 text-sm font-semibold cursor-pointer border disabled:opacity-50 disabled:cursor-not-allowed';
const primary = `${button} bg-accent text-paper border-accent hover:bg-accent-hover`;
const secondary = `${button} bg-panel text-ink border-line hover:border-line-strong`;

export function App() {
  const [page, setPage] = useState<Page>('home');
  const [state, setState] = useState<DesktopState | null>(null);

  useEffect(() => {
    void desktop.state().then(setState);
    desktop.onState(setState);
  }, []);

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-panel">
        <div className="mx-auto max-w-5xl flex items-center gap-6 px-5 py-3">
          <div className="flex items-center gap-2">
            <img src="./favicon.svg?v=2026-11-18" alt="" width={32} height={32} />
            <div className="leading-tight">
              <div className="font-extrabold text-ink-strong">
                Free<span className="text-accent">App</span>Store
              </div>
              <div className="text-xs text-muted">Desktop</div>
            </div>
          </div>
          <nav aria-label="Main" className="flex gap-1">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-current={page === p.id ? 'page' : undefined}
                onClick={() => setPage(p.id)}
                className={`rounded-control px-3 py-1.5 text-sm font-semibold cursor-pointer ${
                  page === p.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <TextSizeToggle />
            {state && (
              <button
                type="button"
                data-testid="profile-summary"
                aria-current={page === 'account' ? 'page' : undefined}
                onClick={() => setPage('account')}
                className="flex items-center gap-2 rounded-control px-2 py-1 text-sm font-semibold cursor-pointer text-ink hover:bg-accent-soft"
              >
                {state.profile ? (
                  <>
                    <Avatar profile={state.profile} size="h-7 w-7" />
                    <span className="max-w-40 truncate">{state.profile.user.name}</span>
                  </>
                ) : (
                  'Sign in'
                )}
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8">
        {state && page !== 'whats-new' && (
          <UpdateBanner state={state} openWhatsNew={() => setPage('whats-new')} />
        )}
        {!state ? null : page === 'home' ? (
          <Home state={state} openStore={() => setPage('store')} />
        ) : page === 'store' ? (
          <Store store={state.store} />
        ) : page === 'whats-new' ? (
          <WhatsNew state={state} />
        ) : page === 'contribute' ? (
          <Contribute state={state.contribute} />
        ) : page === 'account' ? (
          <>
            <Account state={state} />
            <About state={state} openWhatsNew={() => setPage('whats-new')} />
          </>
        ) : (
          <Activity state={state} />
        )}
      </main>
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="m-0 text-xl font-bold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const card = 'rounded-card border border-line bg-panel shadow-surface';

function Home({ state, openStore }: { state: DesktopState; openStore: () => void }) {
  return (
    <>
      <h1 className="mt-0 mb-2 text-3xl font-extrabold">Let your AI work in your apps</h1>
      <p className="mt-0 mb-8 text-muted max-w-2xl">
        Apps that allow AI access offer tools to AI apps on this computer, such as Claude. The tools
        run inside the app, on its local data. Nothing is sent to a server.
      </p>

      <Status state={state} />
      <Clients />

      <Section
        title="Connected apps"
        aside={<span className="text-sm text-muted">{state.openApps.length} open</span>}
      >
        {state.openApps.length === 0 ? (
          <div className={card}>
            <EmptyState
              title="No apps connected"
              message="Open an app from the Store, or open it in your browser and turn on Allow AI access."
              action={
                <button type="button" className={primary} onClick={openStore}>
                  Browse the Store
                </button>
              }
            />
          </div>
        ) : (
          <ul className="m-0 p-0 list-none grid gap-3">
            {state.openApps.map((app) => (
              <ConnectedApp key={`${app.source}:${app.appId}:${app.title}`} app={app} />
            ))}
          </ul>
        )}
        <p className="mt-3 mb-0 text-xs text-muted">
          Apps opened here keep their own local data, separate from your browser. To work on what
          you have in the browser, open the app there and turn on Allow AI access.
        </p>
      </Section>

      <ManualSetup state={state} />
    </>
  );
}

/** On / paused, with Pause and Resume, and Open at login (#815). */
function Status({ state }: { state: DesktopState }) {
  const on = !state.paused && !state.serverError;
  return (
    <section className={`${card} mb-8 p-5`} aria-label="Status">
      {state.serverError && (
        <p
          role="alert"
          className="mt-0 mb-4 rounded-control bg-danger-soft text-danger p-3 text-sm"
        >
          {state.serverError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <span
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 rounded-full ${on ? 'bg-success' : 'bg-warning'}`}
        />
        <div className="min-w-0 flex-1">
          <div data-testid="status" className="text-lg font-bold text-ink-strong">
            {state.paused ? 'AI access is paused' : 'AI access is on'}
          </div>
          <div className="text-sm text-muted">
            {state.paused
              ? 'AI apps get an error until you resume. Your apps keep working as usual.'
              : 'FreeAppStore runs in the background from the menu bar. Closing this window keeps it on.'}
          </div>
        </div>
        <button
          type="button"
          className={state.paused ? primary : secondary}
          onClick={() => desktop.setPaused(!state.paused)}
        >
          {state.paused ? 'Resume AI access' : 'Pause AI access'}
        </button>
      </div>
      <label className="mt-4 pt-4 border-t border-line flex items-center gap-3 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--accent)] cursor-pointer"
          checked={state.openAtLogin}
          onChange={(event) => desktop.setOpenAtLogin(event.target.checked)}
        />
        <span>
          <span className="font-semibold text-ink">Open at login</span>
          <span className="text-muted">
            {' '}
            — start FreeAppStore in the background when you log in
          </span>
        </span>
      </label>
    </section>
  );
}

/** One-click Connect / Disconnect for Claude Code and Claude Desktop (#815). */
function Clients() {
  const [clients, setClients] = useState<ClientStatus[] | null>(null);
  const [busy, setBusy] = useState<ClientId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void desktop.clients().then(setClients);
  }, []);

  const toggle = async (client: ClientStatus) => {
    setBusy(client.id);
    setError(null);
    try {
      setClients(await desktop.setConnected(client.id, !client.connected));
    } catch (e) {
      const message = String((e as Error).message ?? e).replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        '',
      );
      setError(
        `${client.connected ? 'Disconnecting' : 'Connecting'} ${client.name} failed: ${message}`,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Connect your AI">
      <ul className={`${card} m-0 p-0 list-none divide-y divide-line`}>
        {(clients ?? []).map((client) => (
          <li
            key={client.id}
            data-testid={`client-${client.id}`}
            className="flex flex-wrap items-center gap-4 p-5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-ink-strong">{client.name}</span>
                <Badge
                  variant={client.connected ? 'success' : client.detected ? 'default' : 'warning'}
                >
                  {client.connected ? 'Connected' : client.detected ? 'Not connected' : 'Not found'}
                </Badge>
              </div>
              <div className="mt-1 text-sm text-muted">{client.detail}</div>
            </div>
            <button
              type="button"
              className={client.connected ? secondary : primary}
              disabled={busy !== null || (!client.detected && !client.connected)}
              onClick={() => toggle(client)}
            >
              {busy === client.id ? 'Working…' : client.connected ? 'Disconnect' : 'Connect'}
            </button>
          </li>
        ))}
        {!clients && <li className="p-5 text-sm text-muted">Looking for AI apps…</li>}
      </ul>
      {error && (
        <p
          role="alert"
          className="mt-3 mb-0 rounded-control bg-danger-soft text-danger p-3 text-sm"
        >
          {error}
        </p>
      )}
      <p className="mt-3 mb-0 text-xs text-muted">
        Connect adds FreeAppStore to that app's MCP servers; nothing else in its settings changes.
        Start a new Claude Code session, or quit and reopen Claude Desktop, to use it.
      </p>
    </Section>
  );
}

/** The HTTP endpoint and its token, for AI apps without a Connect button. */
function ManualSetup({ state }: { state: DesktopState }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await desktop.copySetupCommand();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <details className={`${card} group`}>
      <summary className="cursor-pointer p-5 font-semibold text-ink">
        Manual setup (other AI apps)
      </summary>
      <div className="px-5 pb-5">
        <p className="mt-0 mb-3 text-sm">
          For an AI app that can't be connected above, add this MCP server. The command is for
          Claude Code; other apps take the same URL and{' '}
          <span className="font-code">Authorization</span> header. The token stays on this computer.
        </p>
        <pre
          data-testid="setup-command"
          className="m-0 mb-4 whitespace-pre-wrap break-all rounded-control bg-panel-alt border border-line p-3 font-code text-sm text-ink"
        >
          {state.setupCommand}
        </pre>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondary} onClick={copy}>
            {copied ? 'Copied' : 'Copy command'}
          </button>
          <button type="button" className={secondary} onClick={() => desktop.regenerateToken()}>
            Regenerate token
          </button>
        </div>
        <p className="mt-4 mb-0 text-xs text-muted">
          MCP server: <span className="font-code">{state.mcpUrl}</span>, reachable only from this
          computer. Apps connected with the buttons above don't use the token, so regenerating it
          doesn't affect them.
        </p>
      </div>
    </details>
  );
}

function ConnectedApp({ app }: { app: OpenApp }) {
  return (
    <li className={`${card} p-4`}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="font-bold text-ink-strong">{app.title || app.appId}</span>
        <span className="font-code text-xs text-muted">{app.appId}</span>
        <Badge variant={app.source === 'desktop' ? 'accent' : 'default'}>
          {app.source === 'desktop' ? 'Desktop window' : 'Browser tab'}
        </Badge>
      </div>
      <ul className="m-0 p-0 list-none grid gap-1 text-sm">
        {app.tools.map((tool) => (
          <li key={tool.name}>
            <span className="font-code text-ink">{tool.name}</span>
            <span className="text-muted"> — {tool.description}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Registry icons are HTML entities such as `&#127463;`. */
const decodeIcon = (icon = '') =>
  icon.replace(/&#(x?)([0-9a-f]+);/gi, (_, hex: string, code: string) =>
    String.fromCodePoint(Number.parseInt(code, hex ? 16 : 10)),
  );

const SORTS = {
  newest: 'Newest',
  popular: 'Most popular',
  az: 'A–Z',
  category: 'Category',
} as const;
type Sort = keyof typeof SORTS;
const SORT_KEY = 'fas-desktop-store-sort';
const LAST = '\uffff';
const isSort = (value: string | null): value is Sort => !!value && value in SORTS;
const byName = (a: RegistryApp, b: RegistryApp) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/** The storefront's orders (#834): apps without a date, votes or category go last, ties by name. */
function sortApps(apps: RegistryApp[], sort: Sort, votes: Record<string, number>) {
  const compare: Record<Sort, (a: RegistryApp, b: RegistryApp) => number> = {
    newest: (a, b) => (b.published ?? '').localeCompare(a.published ?? ''),
    popular: (a, b) => (votes[b.id] ?? 0) - (votes[a.id] ?? 0),
    az: () => 0,
    category: (a, b) => (a.category ?? LAST).localeCompare(b.category ?? LAST),
  };
  return [...apps].sort((a, b) => compare[sort](a, b) || byName(a, b));
}

const CATEGORY_KEY = 'fas-desktop-store-category';
/** Voting needs a storefront sign-in, which the desktop's device credential isn't (#840): vote in the browser. */
const voteUrl = (id: string) => `https://freeappstore.online/?app=${encodeURIComponent(id)}`;

function AppIcon({ app }: { app: RegistryApp }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-xl"
      // Dynamic: each app's own icon colour from the registry.
      style={{ backgroundColor: app.iconBg }}
    >
      {decodeIcon(app.icon)}
    </span>
  );
}

/**
 * Apps from registry.json (#834), with category chips, a Recent row of apps opened on this computer and
 * starred favourites first (#840). Recent and favourites live in the main process's settings, on this computer.
 */
function Store({ store }: { store: DesktopState['store'] }) {
  const [apps, setApps] = useState<RegistryApp[] | null>(null);
  const [votes, setVotes] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(() => {
    const saved = localStorage.getItem(SORT_KEY);
    return isSort(saved) ? saved : 'newest';
  });
  const [category, setCategory] = useState(() => localStorage.getItem(CATEGORY_KEY) ?? '');

  useEffect(() => {
    desktop
      .registry()
      .then((registry) => {
        setApps(registry.apps);
        setVotes(registry.votes);
      })
      .catch(() => setError("Couldn't load the Store. Check your connection and try again."));
  }, []);

  const chooseSort = (value: string) => {
    if (!isSort(value)) return;
    setSort(value);
    localStorage.setItem(SORT_KEY, value);
  };
  const chooseCategory = (value: string) => {
    setCategory(value);
    localStorage.setItem(CATEGORY_KEY, value);
  };

  const categories = [...new Set((apps ?? []).flatMap((app) => app.category ?? []))].sort();
  const active = categories.includes(category) ? category : '';
  const favorites = new Set(store.favorites);
  const q = query.trim().toLowerCase();
  const shown = sortApps(
    (apps ?? []).filter(
      (app) =>
        (!active || app.category === active) &&
        (!q ||
          `${app.name} ${app.category ?? ''} ${app.description ?? ''}`.toLowerCase().includes(q)),
    ),
    sort,
    votes,
  ).sort((a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)));
  const byId = new Map((apps ?? []).map((app) => [app.id, app]));
  const recent = store.recent.flatMap((id) => byId.get(id) ?? []).slice(0, 6);
  const chip = (value: string, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={active === value}
      onClick={() => chooseCategory(value)}
      className={`rounded-full border px-3 py-1 text-sm font-semibold cursor-pointer ${
        active === value
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-line bg-panel text-muted hover:text-ink'
      }`}
    >
      {label}
    </button>
  );

  return (
    <Section
      title="Store"
      aside={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted">
            Sort
            <select
              value={sort}
              onChange={(e) => chooseSort(e.target.value)}
              className="rounded-control border border-line bg-panel px-2 py-1 text-sm text-ink cursor-pointer"
            >
              {(Object.keys(SORTS) as Sort[]).map((key) => (
                <option key={key} value={key}>
                  {SORTS[key]}
                </option>
              ))}
            </select>
          </label>
          <SearchInput value={query} onChange={setQuery} placeholder="Search apps" />
        </div>
      }
    >
      {error && <p className="text-danger">{error}</p>}
      {!apps && !error && <p className="text-muted">Loading…</p>}
      {recent.length > 0 && !q && (
        <section aria-label="Recent" className="mb-6">
          <h3 className="mt-0 mb-2 text-sm font-semibold text-muted">Recent</h3>
          <ul className="m-0 p-0 list-none flex flex-wrap gap-2">
            {recent.map((app) => (
              <li key={app.id}>
                <button
                  type="button"
                  onClick={() => desktop.openApp(app.id)}
                  className={`${card} flex items-center gap-2 py-1.5 pl-1.5 pr-3 text-sm font-semibold text-ink cursor-pointer hover:border-line-strong`}
                >
                  <AppIcon app={app} />
                  {app.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {categories.length > 0 && (
        <fieldset className="m-0 mb-4 border-0 p-0 flex flex-wrap gap-2">
          <legend className="sr-only">Category</legend>
          {chip('', 'All')}
          {categories.map((name) => chip(name, name))}
        </fieldset>
      )}
      <ul className="m-0 p-0 list-none grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((app) => {
          const favorite = favorites.has(app.id);
          const count = votes[app.id] ?? 0;
          return (
            <li key={app.id} data-testid="store-app" className={`${card} p-4 flex flex-col gap-3`}>
              <div className="flex items-center gap-3">
                <AppIcon app={app} />
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-ink-strong truncate">{app.name}</div>
                  {app.category && <div className="text-xs text-muted">{app.category}</div>}
                </div>
                <button
                  type="button"
                  aria-pressed={favorite}
                  aria-label={`Favourite ${app.name}`}
                  title={favorite ? 'Unpin from the top' : 'Pin to the top'}
                  onClick={() => desktop.setFavorite(app.id, !favorite)}
                  className={`shrink-0 bg-transparent border-0 p-1 text-xl leading-none cursor-pointer ${
                    favorite ? 'text-warning' : 'text-muted hover:text-ink'
                  }`}
                >
                  {favorite ? '★' : '☆'}
                </button>
              </div>
              <p className="m-0 text-sm text-muted flex-1">{app.description}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={`${secondary} flex-1`}
                  onClick={() => desktop.openApp(app.id)}
                >
                  Open
                </button>
                <a
                  href={voteUrl(app.id)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Vote for ${app.name} on freeappstore.online (${count} vote${count === 1 ? '' : 's'})`}
                  title="Vote on freeappstore.online"
                  className={`${secondary} no-underline`}
                >
                  <span aria-hidden="true">♥</span> {count}
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000).toLocaleString()} MB`;

/**
 * Contribute (#826): lend this computer to apps that pregenerate narration. Connects with the
 * phone apps' device pairing, then runs in the background, also with this window closed.
 */
function Contribute({ state }: { state: DesktopContribute }) {
  const api = desktop.contribute;
  const intro = (
    <p className="mt-0 mb-6 text-muted max-w-2xl">
      Lend this computer to apps that pregenerate content with a local model (today: narration). It
      generates a job, the platform checks it, and everyone gets it. It keeps going in the
      background while FreeAppStore runs, with this window closed too.
    </p>
  );
  if (!state.connected)
    return (
      <Section title="Contribute">
        {intro}
        <ConnectCard state={state} />
      </Section>
    );
  return (
    <Section
      title="Contribute"
      aside={
        <button type="button" className={secondary} onClick={() => api.disconnect()}>
          Disconnect
        </button>
      }
    >
      {intro}
      <ContributeStatus state={state} />
      <ContributeConditions when={state.when} />
      <ContributeModel state={state} />
      <ContributeApps state={state} />
      <ContributeHistory state={state} />
    </Section>
  );
}

const MODES: { mode: ContributeMode; label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'run-now', label: 'Run now' },
  { mode: 'off', label: 'Off' },
];
const STATUS: Record<DesktopContribute['status'], string> = {
  running: 'Running',
  idle: 'Waiting',
  paused: 'Paused',
  off: 'Off',
};
const modeChip = (on: boolean) =>
  `rounded-full border px-3 py-1 text-sm font-semibold cursor-pointer ${
    on
      ? 'border-accent bg-accent-soft text-accent'
      : 'border-line bg-panel text-muted hover:text-ink'
  }`;

/**
 * What Contribute is doing, and why not (#830), with its mode: Auto runs whenever the conditions
 * hold, Run now once regardless, Off never until turned on again.
 */
function ContributeStatus({ state }: { state: DesktopContribute }) {
  const { current } = state;
  const label =
    state.status === 'running' && state.runNow ? 'Running (Run now)' : STATUS[state.status];
  return (
    <section className={`${card} mb-6 p-5`} aria-label="Contribute status">
      <div className="flex flex-wrap items-center gap-4">
        <span
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 rounded-full ${
            state.status === 'running'
              ? 'bg-success'
              : state.status === 'idle'
                ? 'bg-line-strong'
                : 'bg-warning'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div data-testid="contribute-status" className="text-lg font-bold text-ink-strong">
            {label}
          </div>
          <div data-testid="contribute-why" className="text-sm text-muted">
            {current ? `${current.appId} · ${current.key}` : (state.message ?? 'Looking for work…')}
          </div>
        </div>
        <fieldset className="m-0 flex gap-2 border-0 p-0">
          <legend className="sr-only">Mode</legend>
          {MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              aria-pressed={state.mode === mode}
              className={modeChip(state.mode === mode)}
              onClick={() => desktop.contribute.setMode(mode)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      {current && current.sentences > 0 && (
        <div className="mt-4">
          <ProgressBar
            value={current.sentence}
            max={current.sentences}
            label={`Sentence ${current.sentence} of ${current.sentences}`}
          />
          <p className="mt-1 mb-0 text-xs text-muted">
            {current.charsPerSecond.toFixed(1)} characters per second
          </p>
        </div>
      )}
      <p className="mt-4 mb-0 text-xs text-muted">
        Since FreeAppStore started: {state.submitted} submitted, {state.skipped} skipped (this
        computer couldn't do them exactly), {state.failed} failed. Each job is checked by the
        platform before anyone hears it.
      </p>
    </section>
  );
}

const field = 'rounded-control border border-line bg-panel px-2 py-1 text-sm text-ink';
const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const minuteOf = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** A number input that saves once edited (on leaving it), so a half-typed number is never applied. */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      aria-label={label}
      className={`${field} w-20`}
      value={draft ?? value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) onChange(Number(draft) || 0);
        setDraft(null);
      }}
    />
  );
}

/**
 * When Contribute runs in Auto (#830): power, heat, use, CPU, a daily maximum and quiet hours, all
 * decided on this computer. Checked before each job and between sentences.
 */
function ContributeConditions({ when }: { when: ContributeWhen }) {
  const set = (changes: Partial<ContributeWhen>) => void desktop.contribute.setWhen(changes);
  const row = 'flex flex-wrap items-center gap-3 py-3';
  const name = 'w-44 shrink-0 text-sm font-semibold text-ink';
  const radio = 'flex items-center gap-2 text-sm cursor-pointer';
  const box = 'h-4 w-4 accent-[var(--accent)] cursor-pointer';
  return (
    <section className={`${card} mb-6 p-5`} aria-label="When it runs">
      <h3 className="mt-0 mb-1 text-base font-bold">When it runs</h3>
      <p className="mt-0 mb-2 text-sm text-muted">
        In Auto it runs whenever all of these hold and pauses the moment one does not. A job at
        least 80% done is finished; any other is stopped and given back.
      </p>
      <div className="divide-y divide-line">
        <div className={row} role="radiogroup" aria-label="Power">
          <span className={name}>Power</span>
          <label className={radio}>
            <input
              type="radio"
              className={box}
              checked={!when.onBattery}
              onChange={() => set({ onBattery: false })}
            />
            On AC power only
          </label>
          <label className={radio}>
            <input
              type="radio"
              className={box}
              checked={when.onBattery}
              onChange={() => set({ onBattery: true })}
            />
            Also on battery, from
          </label>
          <NumberField
            label="Minimum battery (%)"
            value={when.minBattery}
            min={5}
            max={100}
            step={5}
            onChange={(minBattery) => set({ minBattery })}
          />
          <span className="text-sm text-muted">%</span>
        </div>
        <label className={`${row} cursor-pointer`}>
          <span className={name}>Heat</span>
          <input
            type="checkbox"
            className={box}
            checked={when.thermalPause}
            onChange={(event) => set({ thermalPause: event.target.checked })}
          />
          <span className="text-sm">Pause when the computer is hot</span>
        </label>
        <label className={row}>
          <span className={name}>While the computer is in use</span>
          <select
            className={`${field} cursor-pointer`}
            value={when.inUse}
            onChange={(event) => set({ inUse: event.target.value as ContributeWhen['inUse'] })}
          >
            <option value="pause">Pause</option>
            <option value="slower">Run slower</option>
          </select>
          <span className="text-xs text-muted">
            In use: a key or the mouse touched in the last 2 minutes.
          </span>
        </label>
        <label className={row}>
          <span className={name}>CPU</span>
          <select
            className={`${field} cursor-pointer`}
            value={when.cpu}
            onChange={(event) => set({ cpu: event.target.value as ContributeWhen['cpu'] })}
          >
            <option value="light">Light (1 thread, long rests)</option>
            <option value="balanced">Balanced (2 threads, short rests)</option>
            <option value="full">Full (up to 4 threads, no rests)</option>
          </select>
        </label>
        <div className={row}>
          <span className={name}>Daily maximum</span>
          <NumberField
            label="Daily maximum jobs"
            value={when.dailyJobs}
            min={0}
            max={10_000}
            step={10}
            onChange={(dailyJobs) => set({ dailyJobs })}
          />
          <span className="text-sm text-muted">jobs</span>
          <NumberField
            label="Daily maximum minutes"
            value={when.dailyMinutes}
            min={0}
            max={1440}
            step={15}
            onChange={(dailyMinutes) => set({ dailyMinutes })}
          />
          <span className="text-sm text-muted">minutes (0: no maximum)</span>
        </div>
        <div className={row}>
          <label className={`${name} flex items-center gap-2 cursor-pointer`}>
            <input
              type="checkbox"
              className={box}
              checked={when.quietHours}
              onChange={(event) => set({ quietHours: event.target.checked })}
            />
            Quiet hours
          </label>
          <input
            type="time"
            aria-label="Quiet hours from"
            className={field}
            value={hhmm(when.quietFrom)}
            disabled={!when.quietHours}
            onChange={(event) => set({ quietFrom: minuteOf(event.target.value) })}
          />
          <span className="text-sm text-muted">to</span>
          <input
            type="time"
            aria-label="Quiet hours to"
            className={field}
            value={hhmm(when.quietTo)}
            disabled={!when.quietHours}
            onChange={(event) => set({ quietTo: minuteOf(event.target.value) })}
          />
        </div>
      </div>
    </section>
  );
}

function ContributeModel({ state }: { state: DesktopContribute }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { model } = state;
  if (state.encoder === false)
    return (
      <p role="alert" className="mb-6 rounded-control bg-danger-soft text-danger p-3 text-sm">
        This computer can't encode AAC audio, so it can't generate.
      </p>
    );
  if (!model) return null;
  const size = megabytes(model.bytes);
  return (
    <section className={`${card} mb-6 p-5`} aria-label="Voice model">
      <h3 className="mt-0 mb-2 text-base font-bold">Voice model</h3>
      <p className="mt-0 mb-3 text-sm">
        {model.engine} · speaks {model.languages} · {size}
      </p>
      {model.ready ? (
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="success">Downloaded</Badge>
          <button type="button" className={secondary} onClick={() => setConfirmDelete(true)}>
            Delete model
          </button>
        </div>
      ) : model.loading !== null ? (
        <ProgressBar
          value={Math.round(model.loading * 100)}
          max={100}
          label={`${model.stage === 'download' ? 'Downloading' : 'Unpacking'} the model: ${Math.round(model.loading * 100)}%`}
        />
      ) : (
        <>
          <p className="mt-0 mb-3 text-sm text-muted">
            Generating downloads the model ({size}, the one the phone apps use) from sherpa-onnx's
            GitHub release once, checks it and keeps it on this computer until you delete it.
          </p>
          <button
            type="button"
            className={primary}
            onClick={() => desktop.contribute.downloadModel()}
          >
            Download the model ({size})
          </button>
        </>
      )}
      <ConfirmDialog
        open={confirmDelete}
        variant="danger"
        title="Delete the model?"
        message="Stops generating and frees the model's storage. You can download it again later."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void desktop.contribute.deleteModel();
        }}
      />
    </section>
  );
}

function ContributeApps({ state }: { state: DesktopContribute }) {
  return (
    <section className={`${card} p-5`} aria-label="Apps with open work">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 className="m-0 text-base font-bold">Apps with open work</h3>
        <button type="button" className={secondary} onClick={() => desktop.contribute.refresh()}>
          Look again
        </button>
      </div>
      {!state.apps ? (
        <p className="m-0 text-sm text-muted">Loading…</p>
      ) : state.apps.length === 0 ? (
        <p className="m-0 text-sm text-muted">No app has open work for you right now.</p>
      ) : (
        <ul className="m-0 p-0 list-none divide-y divide-line">
          {state.apps.map((app) => (
            <li key={app.appId} className="flex flex-wrap items-center gap-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-bold text-ink-strong">{app.appId}</div>
                {app.oneliner && <div className="text-sm text-muted">{app.oneliner}</div>}
                <div className="text-xs text-muted">
                  {app.problem
                    ? `This computer can't run its jobs (${app.problem})`
                    : `${app.open.toLocaleString()} open job${app.open === 1 ? '' : 's'}`}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--accent)] cursor-pointer"
                  aria-label={`Generate for ${app.appId}`}
                  disabled={app.problem !== null}
                  checked={state.optedIn.includes(app.appId)}
                  onChange={(event) => desktop.contribute.setOptIn(app.appId, event.target.checked)}
                />
                Generate for this app
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Segment = [number, number, number, number];
const ms = (n: number) =>
  n >= 10_000
    ? `${(n / 1000).toFixed(0)} s`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)} s`
      : `${Math.round(n)} ms`;
const OUTCOME: Record<HistoryItem['outcome'], string> = {
  in_progress: 'In progress',
  submitted: 'Uploaded',
  skipped: 'Skipped',
  stopped: 'Stopped',
  failed: 'Failed',
};
const VERDICT_TONE = {
  accepted: 'success',
  pending: 'default',
  rejected: 'danger',
  superseded: 'warning',
} as const;

/** An attempt's numbers (#827) as label/value rows: only those it has. */
function attemptRows(item: HistoryItem): [string, string][] {
  const r = item.record;
  const stages = (
    [
      ['load', r.loadMs],
      ['synthesis', r.synthMs],
      ['encode', r.encodeMs],
      ['upload', r.uploadMs],
    ] as const
  )
    .filter(([, n]) => n !== undefined)
    .map(([name, n]) => `${name} ${ms(n!)}`);
  const span = (a?: string, b?: string) => (a === b || !b ? a : `${a ?? '?'} → ${b}`);
  const plug = (c?: boolean) => (c === undefined ? undefined : c ? 'plugged in' : 'on battery');
  const v = item.verdict;
  const rows: [string, string | undefined][] = [
    ['Verdict', v ? `${v.status}${v.reason ? `: ${v.reason}` : ''}` : undefined],
    ['Ended', r.error ? `${r.reason}: ${r.error}` : r.reason],
    ['Ran', r.background ? 'in the background' : 'in the foreground'],
    [
      'Computer',
      [r.device, r.os, r.appVersion && `FreeAppStore ${r.appVersion}`].filter(Boolean).join(' · '),
    ],
    ['Wall time', r.wallMs === undefined ? undefined : ms(r.wallMs)],
    ['Stages', stages.join(' · ') || undefined],
    ['CPU time', r.cpuMs === undefined ? undefined : ms(r.cpuMs)],
    ['Speed', r.rtf === undefined ? undefined : `${r.rtf.toFixed(2)}× real time to synthesize`],
    ['Peak memory', r.peakMemMb === undefined ? undefined : `${r.peakMemMb} MB`],
    ['Power', span(plug(r.chargingStart), plug(r.chargingEnd))],
    ['Thermal', span(r.thermalStart, r.thermalEnd)],
    [
      'Audio',
      r.durationMs === undefined
        ? undefined
        : `${(r.durationMs / 1000).toFixed(1)} s · ${Math.round((r.bytes ?? 0) / 1024)} KB`,
    ],
  ];
  return rows.filter((row): row is [string, string] => !!row[1]);
}

type Current = NonNullable<DesktopContribute['current']>;

/** The job in hand's live numbers (#838), as label/value rows; `now` ticks the elapsed time. */
function liveRows(item: HistoryItem, current: Current, engine: string, now: number) {
  const r = item.record;
  const { sentence, sentences } = current;
  return [
    ['Status', current.encoded ? 'Encoded, uploading' : 'Generating'],
    ['Engine', engine],
    [
      'Progress',
      sentences
        ? `Sentence ${sentence} of ${sentences} (${Math.round((sentence / sentences) * 100)}%)`
        : 'Starting',
    ],
    ['Elapsed', ms(Math.max(0, now - current.at))],
    ['CPU so far', current.cpuMs === null ? undefined : ms(current.cpuMs)],
    [
      'Computer',
      [r.device, r.os, r.appVersion && `FreeAppStore ${r.appVersion}`].filter(Boolean).join(' · '),
    ],
    ['Lease expires', new Date(current.leaseExpiresAt).toLocaleTimeString()],
  ].filter((row): row is [string, string] => !!row[1]);
}

/** This computer's attempts (#827): what it generated, how it went, and playback of its audio. */
function ContributeHistory({ state }: { state: DesktopContribute }) {
  const version = state.historyVersion;
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  // By key, so the detail stays open when the history is read again (a report was sent)
  const [open, setOpen] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` says the history changed
  useEffect(() => {
    void desktop.contribute.history().then(setItems);
  }, [version]);
  return (
    <section className={`${card} mt-6 p-5`} aria-label="History">
      <h3 className="mt-0 mb-3 text-base font-bold">History</h3>
      {!items?.length ? (
        <p className="m-0 text-sm text-muted">Nothing generated on this computer yet.</p>
      ) : (
        <ul className="m-0 p-0 list-none divide-y divide-line">
          {items.map((item) => {
            const key = `${item.appId}/${item.jobId}/${item.at}`;
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => setOpen(open === key ? null : key)}
                  aria-expanded={open === key}
                  className="w-full text-left py-2 flex flex-wrap items-center gap-x-3 gap-y-1 cursor-pointer bg-transparent border-0 text-ink"
                >
                  <Badge variant={item.verdict ? VERDICT_TONE[item.verdict.status] : 'default'}>
                    {item.verdict?.status ?? OUTCOME[item.outcome]}
                  </Badge>
                  <span className="font-bold">{item.appId}</span>
                  <span className="font-code text-sm break-all min-w-0">{item.key}</span>
                  {item.verdict?.report && (
                    <span
                      className={`text-xs font-bold ${item.verdict.report.good ? 'text-success' : 'text-danger'}`}
                    >
                      {item.verdict.report.good ? 'Good' : 'Not good'}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted">
                    {new Date(item.at).toLocaleString()}
                  </span>
                </button>
                {open === key && (
                  <HistoryDetail
                    item={item}
                    inHand={
                      item.outcome === 'in_progress' &&
                      state.current?.jobId === item.jobId &&
                      state.current.at === item.at
                        ? state.current
                        : null
                    }
                    engine={state.model?.engine ?? ''}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function HistoryDetail({
  item,
  inHand,
  engine,
}: {
  item: HistoryItem;
  /** The job in hand's live state, while it is this item (#838). */
  inHand: Current | null;
  engine: string;
}) {
  const [audio, setAudio] = useState<{ url: string; segments: Segment[] } | null | undefined>();
  const [time, setTime] = useState(-1);
  const [now, setNow] = useState(Date.now());
  const [saved, setSaved] = useState<string | null>(null);
  const markRef = useRef<HTMLElement>(null);
  const live = inHand !== null;
  const encoded = inHand?.encoded ?? item.outcome !== 'in_progress';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  useEffect(() => {
    if (!encoded) return; // the job in hand's audio is kept once it is encoded
    let url: string | null = null;
    let closed = false;
    void desktop.contribute.audio(item.appId, item.jobId).then((kept) => {
      if (closed) return;
      if (!kept) return setAudio(null);
      url = URL.createObjectURL(new Blob([kept.audio as BlobPart], { type: 'audio/mp4' }));
      const segments = (kept.meta as { segments?: Segment[] }).segments ?? [];
      setAudio({ url, segments });
    });
    return () => {
      closed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.appId, item.jobId, encoded]);
  const current = audio?.segments.find(([, , start, end]) => time >= start && time < end);
  const marked = current && current[1] <= item.text.length ? current : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the sentence being read
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'nearest' });
  }, [marked?.[0]]);
  return (
    <div className="pb-4">
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {(inHand ? liveRows(item, inHand, engine, now) : attemptRows(item)).map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted">{name}</dt>
            <dd className="m-0 break-words min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      {audio ? (
        // biome-ignore lint/a11y/useMediaCaption: generated narration of the text shown below
        <audio
          controls
          src={audio.url}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          className="mt-3 w-full"
        />
      ) : (
        audio === null && (
          <p className="mt-3 mb-0 text-xs text-muted">
            Its audio is no longer kept (only the latest 20 are).
          </p>
        )
      )}
      <p className="mt-2 mb-0 text-sm text-muted whitespace-pre-line break-words max-h-48 overflow-y-auto">
        {marked ? (
          <>
            {item.text.slice(0, marked[0])}
            <mark ref={markRef} className="bg-accent-soft text-ink rounded">
              {item.text.slice(marked[0], marked[1])}
            </mark>
            {item.text.slice(marked[1])}
          </>
        ) : (
          item.text
        )}
        {item.text.length < item.chars ? '…' : ''}
      </p>
      {item.verdict?.submissionId && <ReportForm item={item} />}
      {item.outcome !== 'in_progress' && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={secondary}
            onClick={async () =>
              setSaved(await desktop.contribute.saveRecord(item.appId, item.jobId, item.at))
            }
          >
            Save record…
          </button>
          {saved && <span className="text-xs text-muted break-all">Saved to {saved}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Good / Not good for this computer's upload, with an optional note (#831): people judge the
 * audio, no AI does. The app owner sees it; sending again changes it.
 */
function ReportForm({ item }: { item: HistoryItem }) {
  const report = item.verdict?.report ?? null;
  const [good, setGood] = useState<boolean | null>(report?.good ?? null);
  const [note, setNote] = useState(report?.note ?? '');
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle');
  const send = async () => {
    if (good === null) return;
    setState('sending');
    try {
      await desktop.contribute.report(item.appId, item.jobId, good, note.trim());
      setState('idle');
    } catch {
      setState('error');
    }
  };
  const choice = (value: boolean, label: string, tone: string) => (
    <button
      type="button"
      aria-pressed={good === value}
      onClick={() => setGood(value)}
      className={`rounded-lg border px-3 py-1 text-sm font-bold cursor-pointer ${good === value ? tone : 'border-line bg-transparent text-ink'}`}
    >
      {label}
    </button>
  );
  return (
    <fieldset className="mt-3 border-0 p-0 m-0">
      <legend className="text-sm font-bold mb-2">Was this upload good?</legend>
      <div className="flex flex-wrap gap-2">
        {choice(true, 'Good', 'border-success bg-success-soft text-success')}
        {choice(false, 'Not good', 'border-danger bg-danger-soft text-danger')}
      </div>
      <textarea
        aria-label="Note (optional)"
        value={note}
        maxLength={500}
        rows={2}
        onChange={(e) => setNote(e.currentTarget.value)}
        placeholder="Note (optional), e.g. a skipped sentence"
        className="mt-2 w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={send}
          disabled={good === null || state === 'sending'}
          className="rounded-lg border-0 bg-ink px-3 py-1 text-sm font-bold text-paper cursor-pointer disabled:opacity-50"
        >
          {state === 'sending' ? 'Sending…' : report ? 'Change' : 'Send'}
        </button>
        <span role="status" className="text-xs text-muted">
          {state === 'error'
            ? "Couldn't send it. Try again."
            : report
              ? `You said ${report.good ? 'Good' : 'Not good'}. The app owner sees it.`
              : 'The app owner sees what you say. Nothing else checks the audio.'}
        </span>
      </div>
    </fieldset>
  );
}

function Activity({ state }: { state: DesktopState }) {
  return (
    <Section title="AI activity">
      {state.log.length === 0 ? (
        <div className={card}>
          <EmptyState
            title="No AI calls yet"
            message="Each call an AI client makes through FreeAppStore shows up here."
          />
        </div>
      ) : (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-muted">
                <th className="px-4 py-2 font-semibold">Time</th>
                <th className="px-4 py-2 font-semibold">Tool</th>
                <th className="px-4 py-2 font-semibold">App</th>
                <th className="px-4 py-2 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {state.log.map((entry) => (
                <tr key={entry.id} className="border-t border-line align-top">
                  <td className="px-4 py-2 whitespace-nowrap text-muted">
                    {new Date(entry.at).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-2 font-code">
                    {entry.tool}
                    {entry.appTool && <span className="text-muted"> → {entry.appTool}</span>}
                  </td>
                  <td className="px-4 py-2 font-code">{entry.appId ?? '—'}</td>
                  <td className="px-4 py-2">
                    {entry.ok ? (
                      <Badge variant="success">ok</Badge>
                    ) : (
                      <>
                        <Badge variant="danger">error</Badge>
                        <div className="mt-1 text-muted">{entry.error}</div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/** Connect this computer with the phone apps' device pairing (#826); also the Account page's sign-in. */
function ConnectCard({ state }: { state: DesktopContribute }) {
  const api = desktop.contribute;
  return (
    <div className={`${card} p-5`}>
      <p className="mt-0 mb-4 text-sm">
        Connect this computer to your FreeAppStore account. Your browser opens the device connection
        page the phone apps use: sign in there and approve.
      </p>
      {state.pairError && (
        <p
          role="alert"
          className="mt-0 mb-4 rounded-control bg-danger-soft text-danger p-3 text-sm"
        >
          {state.pairError}
        </p>
      )}
      {state.pairing ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">Waiting for you to approve in your browser…</span>
          <button type="button" className={secondary} onClick={() => api.cancel()}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className={primary} onClick={() => api.connect()}>
          Connect this computer
        </button>
      )}
    </div>
  );
}

type DesktopProfile = NonNullable<DesktopState['profile']>;

/** The account's picture (a data: URL from the main process), its initial until it loads. */
function Avatar({ profile, size }: { profile: DesktopProfile; size: string }) {
  return profile.avatar ? (
    <img src={profile.avatar} alt="" className={`${size} shrink-0 rounded-full object-cover`} />
  ) : (
    <span
      aria-hidden="true"
      className={`${size} shrink-0 inline-flex items-center justify-center rounded-full bg-accent-soft text-accent font-bold`}
    >
      {profile.user.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const PROVIDERS: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  apple: 'Apple',
  email: 'Email',
};
const CONSOLE_URL = 'https://freeappstore.online/app/';
const DELETE_ACCOUNT_URL = 'https://freeappstore.online/app/settings?delete-account=1';
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'long' });

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
      <dt className="text-sm font-semibold text-ink">{label}</dt>
      <dd className="m-0 text-sm text-muted break-all">{value}</dd>
    </div>
  );
}

/** The signed-in account in full, and this computer's connection (#829). */
function Account({ state }: { state: DesktopState }) {
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const { profile } = state;
  if (!state.contribute.connected)
    return (
      <Section title="Account">
        <ConnectCard state={state.contribute} />
      </Section>
    );
  if (!profile)
    return (
      <Section title="Account">
        <p className="text-muted">Loading your account…</p>
      </Section>
    );
  const { user, device } = profile;
  const provider = PROVIDERS[user.provider] ?? user.provider;
  const link = 'text-accent font-semibold hover:underline';
  return (
    <Section
      title="Account"
      aside={
        <button type="button" className={secondary} onClick={() => setConfirmSignOut(true)}>
          Sign out
        </button>
      }
    >
      <div className="mb-6 flex items-center gap-4">
        <Avatar profile={profile} size="h-16 w-16" />
        <div className="min-w-0">
          <div data-testid="profile-name" className="text-2xl font-extrabold text-ink-strong">
            {user.name}
          </div>
          <div className="text-muted">{user.login ? `@${user.login}` : provider}</div>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <section className={`${card} p-5`} aria-label="Profile">
          <dl className="m-0 divide-y divide-line">
            <Row label="Signed in with" value={provider} />
            <Row label="User ID" value={<span className="font-code">{user.id}</span>} />
            {user.email && <Row label="Email" value={user.email} />}
            <Row label="Roles" value={user.roles.join(', ')} />
            {user.roles.includes('creator') && (
              <Row
                label="Your apps"
                value={
                  <>
                    {user.appCount}{' '}
                    <a href={CONSOLE_URL} target="_blank" rel="noreferrer" className={link}>
                      Open the console
                    </a>
                  </>
                }
              />
            )}
          </dl>
        </section>
        <section className={`${card} p-5`} aria-label="This computer">
          <dl className="m-0 divide-y divide-line">
            <Row label="This computer" value={device.label} />
            <Row label="Version" value={state.version} />
            <Row label="Connected" value={day(device.createdAt)} />
            <Row label="Connection expires" value={day(device.expiresAt)} />
          </dl>
        </section>
      </div>
      <AddPhone />
      <div className="mt-6 flex flex-wrap gap-6 text-sm">
        <a href={CONSOLE_URL} target="_blank" rel="noreferrer" className={link}>
          Manage account
        </a>
        <a
          href={DELETE_ACCOUNT_URL}
          target="_blank"
          rel="noreferrer"
          className="text-danger font-semibold hover:underline"
        >
          Delete account
        </a>
      </div>
      <ConfirmDialog
        open={confirmSignOut}
        title="Sign out of this computer?"
        message="Stops contributing and removes this computer's connection to your account. You can connect it again any time."
        confirmLabel="Sign out"
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => {
          setConfirmSignOut(false);
          void desktop.contribute.disconnect();
        }}
      />
    </Section>
  );
}

/** `text` as a QR code, dark on white whatever the theme, so every camera reads it. */
function QrCode({ text }: { text: string }) {
  const { size, data } = encode(text, { border: 2 });
  const path = data
    .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : '')))
    .join('');
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing QR code"
      className="h-48 w-48 shrink-0 rounded-control"
    >
      <rect width={size} height={size} className="fill-white" />
      <path d={path} className="fill-black" />
    </svg>
  );
}

/**
 * Add a phone (#845): a 5-minute, single-use code from the server, as a QR for the phone app to
 * scan and as text to type (docs/native-companion.md). The console lists the devices.
 */
function AddPhone() {
  const [pair, setPair] = useState<PairCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!pair) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pair]);
  const create = async () => {
    setError(null);
    try {
      setPair(await desktop.pairCode());
      setNow(Date.now());
    } catch (err) {
      setError(
        (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      );
    }
  };
  const left = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0;
  return (
    <section className={`${card} mt-6 p-5`} aria-label="Add a phone">
      <h3 className="mt-0 mb-2 text-base font-bold">Add a phone</h3>
      {!pair ? (
        <>
          <p className="mt-0 mb-4 text-sm text-muted">
            Connect the FreeAppStore phone app to this account by scanning a code, without signing
            in on the phone.
          </p>
          <button type="button" className={secondary} onClick={create}>
            Show a code
          </button>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          {left > 0 && <QrCode text={pair.url} />}
          <div className="min-w-0">
            <p className="mt-0 mb-2 text-sm">Scan with the FreeAppStore app, or type this code:</p>
            <p data-testid="pair-code" className="mt-0 mb-2 font-code text-lg select-all">
              {pair.code}
            </p>
            <p className="mt-0 mb-4 text-xs text-muted">
              {left > 0
                ? `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more. See your devices in the console.`
                : 'This code expired.'}
            </p>
            <div className="flex flex-wrap gap-3">
              {left === 0 && (
                <button type="button" className={secondary} onClick={create}>
                  New code
                </button>
              )}
              <button type="button" className={secondary} onClick={() => setPair(null)}>
                {left > 0 ? 'Cancel' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mt-4 mb-0 rounded-control bg-danger-soft text-danger p-3 text-sm"
        >
          {error}
        </p>
      )}
    </section>
  );
}

/** This build's version, build number and commit, its release notes (#832), and updates (#839). */
function About({ state, openWhatsNew }: { state: DesktopState; openWhatsNew: () => void }) {
  const { updates } = state;
  const checked = updates.checkedAt
    ? `Last checked ${new Date(updates.checkedAt).toLocaleString()}.`
    : '';
  return (
    <Section title="About">
      <section className={`${card} p-5`} aria-label="About">
        <dl className="m-0 divide-y divide-line">
          <Row label="Version" value={<span data-testid="app-version">{state.version}</span>} />
        </dl>
        {updates.supported ? (
          <div className="mt-4 pt-4 border-t border-line">
            <label className="flex items-center gap-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)] cursor-pointer"
                checked={updates.auto}
                onChange={(event) => desktop.setAutoUpdate(event.target.checked)}
              />
              <span>
                <span className="font-semibold text-ink">Check for updates automatically</span>
                <span className="text-muted"> — when FreeAppStore starts and once a day</span>
              </span>
            </label>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={secondary}
                disabled={updates.status === 'checking' || updates.status === 'downloading'}
                onClick={() => desktop.update('check')}
              >
                {updates.status === 'checking' ? 'Checking…' : 'Check now'}
              </button>
              <span className="text-xs text-muted">
                {updates.status === 'error'
                  ? `Couldn't check for updates (${updates.error}).`
                  : updates.version
                    ? `Version ${updates.version} is available.`
                    : `${checked} This is the newest version.`.trim()}
              </span>
            </div>
          </div>
        ) : (
          <p className="mt-4 mb-0 text-xs text-muted">
            Development build: installed builds check for updates.
          </p>
        )}
      </section>
      <div className="mt-4 text-sm">
        <button
          type="button"
          onClick={openWhatsNew}
          className="bg-transparent border-0 p-0 text-accent font-semibold hover:underline cursor-pointer"
        >
          What's new
        </button>
      </div>
    </Section>
  );
}

/** A newer version (#839): Restart to update when downloaded, or (macOS) download it. */
function UpdateBanner({ state, openWhatsNew }: { state: DesktopState; openWhatsNew: () => void }) {
  const { status, version, percent } = state.updates;
  if (!version || (status !== 'ready' && status !== 'manual' && status !== 'downloading'))
    return null;
  return (
    <section
      aria-label="Update"
      className={`${card} mb-6 p-4 flex flex-wrap items-center gap-3 border-accent`}
    >
      <div className="min-w-0 flex-1 text-sm">
        <span className="font-bold text-ink-strong">
          {status === 'ready'
            ? `FreeAppStore ${version} is ready to install.`
            : `FreeAppStore ${version} is available.`}
        </span>{' '}
        <span className="text-muted">
          {status === 'downloading'
            ? `Downloading… ${percent ?? 0}%`
            : status === 'manual'
              ? 'Download it and replace the app in Applications.'
              : 'Restarting takes a few seconds.'}
        </span>
      </div>
      <button type="button" className={secondary} onClick={openWhatsNew}>
        What's new
      </button>
      {status !== 'downloading' && (
        <button type="button" className={primary} onClick={() => desktop.update('apply')}>
          {status === 'ready' ? 'Restart to update' : 'Download'}
        </button>
      )}
    </section>
  );
}

type ReleaseNotes = Awaited<ReturnType<typeof desktop.releaseNotes>>;

/** Release notes (the GitHub release body) of the newer version, if any, and of this one (#839). */
function WhatsNew({ state }: { state: DesktopState }) {
  const current = state.version.split(' ')[0]!;
  const versions = [state.updates.version, current].filter(
    (v, i, all): v is string => !!v && all.indexOf(v) === i,
  );
  return (
    <Section title="What's new">
      {versions.map((version) => (
        <ReleaseNotesCard key={version} version={version} current={version === current} />
      ))}
      <a
        href="https://github.com/freeappstore-online/platform/releases?q=desktop-v&expanded=true"
        target="_blank"
        rel="noreferrer"
        className="text-sm text-accent font-semibold hover:underline"
      >
        All desktop releases
      </a>
    </Section>
  );
}

function ReleaseNotesCard({ version, current }: { version: string; current: boolean }) {
  const [notes, setNotes] = useState<ReleaseNotes | undefined>();
  const [error, setError] = useState(false);
  useEffect(() => {
    desktop
      .releaseNotes(version)
      .then(setNotes)
      .catch(() => setError(true));
  }, [version]);
  const lines = (notes?.body ?? '').split(/\r?\n/).filter((line) => line.trim());
  return (
    <section className={`${card} mb-6 p-5`} aria-label={`Version ${version}`}>
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h3 className="m-0 text-base font-bold">Version {version}</h3>
        <Badge variant={current ? 'default' : 'accent'}>{current ? 'This version' : 'New'}</Badge>
        {notes?.published && (
          <span className="text-xs text-muted">
            {new Date(notes.published).toLocaleDateString(undefined, { dateStyle: 'long' })}
          </span>
        )}
      </div>
      {error ? (
        <p className="m-0 text-sm text-muted">
          Couldn't load the release notes. Check your connection.
        </p>
      ) : notes === undefined ? (
        <p className="m-0 text-sm text-muted">Loading…</p>
      ) : notes === null ? (
        <p className="m-0 text-sm text-muted">This version has no release notes.</p>
      ) : (
        <div data-testid="release-notes" className="text-sm">
          {lines
            .filter((line) => !line.startsWith('- '))
            .map((line) => (
              <p key={line} className="mt-0 mb-2">
                {line}
              </p>
            ))}
          <ul className="m-0 pl-5 list-disc">
            {lines
              .filter((line) => line.startsWith('- '))
              .map((line) => (
                <li key={line}>{line.slice(2)}</li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

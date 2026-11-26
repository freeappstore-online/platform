import {
  Badge,
  ConfirmDialog,
  EmptyState,
  ProgressBar,
  SearchInput,
  TextSizeToggle,
  ThemeToggle,
} from '@freeappstore/sdk/ui';
import { type ReactNode, useEffect, useState } from 'react';
import type {
  ClientId,
  ClientStatus,
  DesktopContribute,
  DesktopState,
  OpenApp,
  RegistryApp,
} from './desktop.js';

type Page = 'home' | 'store' | 'contribute' | 'activity';
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
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8">
        {!state ? null : page === 'home' ? (
          <Home state={state} openStore={() => setPage('store')} />
        ) : page === 'store' ? (
          <Store />
        ) : page === 'contribute' ? (
          <Contribute state={state.contribute} />
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

function Store() {
  const [apps, setApps] = useState<RegistryApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    desktop
      .registry()
      .then((registry) => setApps(registry.apps))
      .catch(() => setError("Couldn't load the Store. Check your connection and try again."));
  }, []);

  const q = query.trim().toLowerCase();
  const shown = (apps ?? []).filter(
    (app) =>
      !q || `${app.name} ${app.category ?? ''} ${app.description ?? ''}`.toLowerCase().includes(q),
  );

  return (
    <Section
      title="Store"
      aside={<SearchInput value={query} onChange={setQuery} placeholder="Search apps" />}
    >
      {error && <p className="text-danger">{error}</p>}
      {!apps && !error && <p className="text-muted">Loading…</p>}
      <ul className="m-0 p-0 list-none grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((app) => (
          <li key={app.id} className={`${card} p-4 flex flex-col gap-3`}>
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-xl"
                // Dynamic: each app's own icon colour from the registry.
                style={{ backgroundColor: app.iconBg }}
              >
                {decodeIcon(app.icon)}
              </span>
              <div className="min-w-0">
                <div className="font-bold text-ink-strong truncate">{app.name}</div>
                {app.category && <div className="text-xs text-muted">{app.category}</div>}
              </div>
            </div>
            <p className="m-0 text-sm text-muted flex-1">{app.description}</p>
            <button type="button" className={secondary} onClick={() => desktop.openApp(app.id)}>
              Open
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const DEVICE_LABEL = { webgpu: 'WebGPU', wasm: 'WebAssembly' } as const;
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
        <div className={`${card} p-5`}>
          <p className="mt-0 mb-4 text-sm">
            Connect this computer to your FreeAppStore account. Your browser opens the device
            connection page the phone apps use: sign in there and approve.
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
              <span className="text-sm text-muted">
                Waiting for you to approve in your browser…
              </span>
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
      <ContributeModel state={state} />
      <ContributeApps state={state} />
    </Section>
  );
}

function ContributeStatus({ state }: { state: DesktopContribute }) {
  const { current } = state;
  const label =
    state.status === 'running' ? 'Running' : state.status === 'paused' ? 'Paused' : 'Idle';
  return (
    <section className={`${card} mb-6 p-5`} aria-label="Contribute status">
      <div className="flex flex-wrap items-center gap-4">
        <span
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 rounded-full ${
            state.status === 'running'
              ? 'bg-success'
              : state.status === 'paused'
                ? 'bg-warning'
                : 'bg-line-strong'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div data-testid="contribute-status" className="text-lg font-bold text-ink-strong">
            {label}
          </div>
          <div className="text-sm text-muted">
            {current
              ? `${current.appId} · ${current.key}`
              : state.status === 'paused'
                ? 'Resume to go on generating.'
                : (state.message ?? 'Looking for work…')}
          </div>
        </div>
        <button
          type="button"
          className={state.paused ? primary : secondary}
          onClick={() => desktop.contribute.setPaused(!state.paused)}
        >
          {state.paused ? 'Resume' : 'Pause'}
        </button>
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
        Kokoro TTS v1.0 on {DEVICE_LABEL[model.device]} · {size}
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
          label={`Downloading the model: ${Math.round(model.loading * 100)}%`}
        />
      ) : (
        <>
          <p className="mt-0 mb-3 text-sm text-muted">
            Generating downloads the model ({size}) from Hugging Face once and keeps it on this
            computer until you delete it.
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

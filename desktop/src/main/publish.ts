// Publishing from the desktop (#800): a GUI over the bundled `fas` CLI (src/cli/fas.mts). Sign-in, init, check
// and publish are the CLI's own code; this file runs it and git, and reads their results.
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES } from './categories.js';
import { APP_ID } from './security.js';

const ONELINER_MAX = 200;
const OUTPUT_LINES = 200;

/** An app this account published (`GET /v1/apps/mine`). */
export interface MyApp {
  id: string;
  oneliner: string | null;
  category: string | null;
  appUrl: string;
  repoUrl: string;
}

export interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

/** An app folder on this computer. */
export interface Project {
  path: string;
  /** fas.json's appId, or null when the folder has none (it can't be published). */
  appId: string | null;
  /** Uncommitted files, or null when the folder isn't a git repository. */
  changes: number | null;
  checks: CheckResult[] | null;
}

export interface PublishState {
  /** The CLI's sign-in (`fas whoami`); null when signed out. */
  account: { login: string; expired: boolean } | null;
  /** GitHub's device code while `fas login` waits for the user. */
  signIn: { url: string; code: string } | null;
  /** This account's published apps; null until loaded. */
  apps: MyApp[] | null;
  projects: Project[];
  /** The command running or last run, and its output. */
  task: { label: string; running: boolean; ok: boolean | null; output: string[] } | null;
}

// ── The CLI's output ────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character starts ANSI colour codes
const ANSI = /\u001b\[[0-9;]*m/g;
export const plain = (text: string) => text.replace(ANSI, '');

/** `fas login`'s "Open <url> and enter code: <code>"; only a GitHub URL. */
export function parseDeviceCode(text: string): { url: string; code: string } | null {
  const match = /Open (https:\/\/github\.com\/\S+) and enter code: (\S+)/.exec(plain(text));
  return match ? { url: match[1]!, code: match[2]! } : null;
}

/** `fas whoami`: "@login" and its session line, or null when signed out. */
export function parseWhoami(code: number, text: string): PublishState['account'] {
  const out = plain(text);
  const login = /^@(\S+)/m.exec(out)?.[1];
  if (code !== 0 || !login || /Session: none/.test(out)) return null;
  return { login, expired: /Session: expired/.test(out) };
}

export function parseMyApps(text: string): MyApp[] {
  const { apps } = JSON.parse(text) as { apps: MyApp[] };
  return apps.map(({ id, oneliner, category, appUrl, repoUrl }) => ({
    id,
    oneliner,
    category,
    appUrl,
    repoUrl,
  }));
}

/** `fas check --json`, or null when it printed something else (it failed before checking). */
export function parseChecks(text: string): CheckResult[] | null {
  try {
    const results = JSON.parse(text) as CheckResult[];
    return Array.isArray(results)
      ? results.map(({ name, status, detail }) => ({ name, status, detail: detail ?? '' }))
      : null;
  } catch {
    return null;
  }
}

/** The arguments of `fas publish` for one app, or the reason they can't be made. */
export function publishArgs(
  appId: string,
  input: { category: string; oneliner: string },
): string[] | string {
  if (!APP_ID.test(appId)) return 'This folder has no valid app id in fas.json.';
  if (!(CATEGORIES as readonly string[]).includes(input.category)) return 'Choose a category.';
  const oneliner = input.oneliner.trim().replace(/\s+/g, ' ');
  if (!oneliner) return 'Write a one-line description.';
  if (oneliner.length > ONELINER_MAX)
    return `Keep the description under ${ONELINER_MAX} characters.`;
  return [
    'publish',
    '--yes',
    '--name',
    appId,
    '--category',
    input.category,
    '--type',
    'standalone',
    '--oneliner',
    oneliner,
  ];
}

/**
 * Where Push sends an app: its own repository in the freeappstore-online org, as `/v1/publish` recorded it.
 * Dev builds take any URL the (stand-in) API gives.
 */
export function pushUrl(app: MyApp, dev: boolean): string | null {
  if (dev) return `${app.repoUrl}.git`;
  return app.repoUrl === `https://github.com/freeappstore-online/${app.id}`
    ? `${app.repoUrl}.git`
    : null;
}

/** fas.json's appId, or null. */
export function readAppId(dir: string): string | null {
  try {
    const { appId } = JSON.parse(readFileSync(join(dir, 'fas.json'), 'utf8')) as {
      appId?: unknown;
    };
    return typeof appId === 'string' && APP_ID.test(appId) ? appId : null;
  } catch {
    return null;
  }
}

// ── Running commands ────────────────────────────────────────────

export interface Command {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type Run = (
  command: Command,
  cwd: string,
  line: (text: string) => void,
) => { child: ChildProcess | null; done: Promise<{ code: number; stdout: string }> };

/** Runs a command without a shell, reporting each line of its output (stdout and stderr); resolves with stdout. */
export const run: Run = ({ command, args, env }, cwd, line) => {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let pending = '';
  const take = (chunk: Buffer) => {
    const text = plain(chunk.toString());
    const lines = (pending + text).split('\n');
    pending = lines.pop() ?? '';
    for (const l of lines) line(l);
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    take(chunk);
  });
  child.stderr?.on('data', take);
  const done = new Promise<{ code: number; stdout: string }>((resolve) => {
    child.on('error', (error) => {
      line(error.message);
      resolve({ code: -1, stdout });
    });
    child.on('close', (code) => {
      if (pending) line(pending);
      resolve({ code: code ?? -1, stdout: plain(stdout) });
    });
  });
  return { child, done };
};

export interface PublisherOptions {
  /** The CLI: this app's binary in node mode with dist/cli/fas.mjs. */
  fas: Command;
  /** git, with the same environment. */
  git: Command;
  dev: boolean;
  projects: () => string[];
  saveProjects: (paths: string[]) => void;
  open: (url: string) => void;
  changed: () => void;
  run?: Run;
}

/** The Publish page's state and actions. One command runs at a time. */
export class Publisher {
  state: PublishState = { account: null, signIn: null, apps: null, projects: [], task: null };
  private checks = new Map<string, CheckResult[]>();
  private child: ChildProcess | null = null;
  private readonly run: Run;

  constructor(private readonly options: PublisherOptions) {
    this.run = options.run ?? run;
  }

  get busy() {
    return this.state.task?.running === true;
  }

  /** Account, apps and projects, read again. */
  async refresh(): Promise<void> {
    if (this.busy) return;
    const whoami = await this.quiet(['whoami']);
    this.state.account = parseWhoami(whoami.code, whoami.stdout);
    if (this.state.account && !this.state.account.expired) {
      const mine = await this.quiet(['--my-apps']);
      this.state.apps = mine.code === 0 ? parseMyApps(mine.stdout) : null;
    } else this.state.apps = null;
    await this.readProjects();
  }

  async signIn(): Promise<void> {
    await this.task('Sign in', this.options.fas, ['login'], '', (line) => {
      const device = parseDeviceCode(line);
      if (!device) return;
      this.state.signIn = device;
      this.options.open(device.url);
    });
    this.state.signIn = null;
    await this.refresh();
  }

  /** Signs out of the CLI too: it is one sign-in. */
  async signOut(): Promise<void> {
    await this.task('Sign out', this.options.fas, ['logout'], '');
    await this.refresh();
  }

  cancel(): void {
    this.child?.kill();
  }

  /** `fas init <id>` in `parent`; the new folder becomes a project. */
  async create(parent: string, appId: string): Promise<boolean> {
    if (!APP_ID.test(appId)) {
      this.fail('New app', 'App ids are lowercase letters, digits and hyphens, like "moon-tides".');
      return false;
    }
    const { ok } = await this.task('New app', this.options.fas, ['init', appId], parent);
    if (ok) await this.add(join(parent, appId));
    return ok;
  }

  /** Adds an app folder; false when it has no fas.json app id. */
  async add(path: string): Promise<boolean> {
    if (!readAppId(path)) return false;
    const paths = this.options.projects();
    if (!paths.includes(path)) this.options.saveProjects([...paths, path]);
    await this.readProjects();
    return true;
  }

  async remove(path: string): Promise<void> {
    this.options.saveProjects(this.options.projects().filter((p) => p !== path));
    this.checks.delete(path);
    await this.readProjects();
  }

  async check(path: string): Promise<void> {
    const { stdout } = await this.task('Check', this.options.fas, ['check', '--json'], path);
    const results = parseChecks(stdout);
    if (results) this.checks.set(path, results);
    await this.readProjects();
  }

  async publish(path: string, input: { category: string; oneliner: string }): Promise<boolean> {
    const appId = readAppId(path) ?? '';
    const args = publishArgs(appId, input);
    if (typeof args === 'string') {
      this.fail('Publish', args);
      return false;
    }
    const { ok } = await this.task('Publish', this.options.fas, args, path);
    await this.refresh();
    return ok;
  }

  /** Commits every change (with `message`) and pushes main to the app's repository: push to main deploys. */
  async push(path: string, message: string): Promise<boolean> {
    const appId = readAppId(path);
    const app = this.state.apps?.find((a) => a.id === appId);
    const url = app && pushUrl(app, this.options.dev);
    if (!url) {
      this.fail('Push', 'Publish this app first: it has no repository yet.');
      return false;
    }
    const changes = await this.changes(path);
    if (changes) {
      if (!message.trim()) {
        this.fail('Push', 'Describe your changes, then push.');
        return false;
      }
      if (!(await this.task('Commit', this.options.git, ['add', '-A'], path)).ok) return false;
      const commit = ['commit', '-q', '-m', message.trim()];
      if (!(await this.task('Commit', this.options.git, commit, path)).ok) return false;
    }
    const { ok } = await this.task('Push', this.options.git, ['push', url, 'main'], path);
    await this.readProjects();
    return ok;
  }

  private async readProjects(): Promise<void> {
    this.state.projects = await Promise.all(
      this.options.projects().map(async (path) => ({
        path,
        appId: readAppId(path),
        changes: await this.changes(path),
        checks: this.checks.get(path) ?? null,
      })),
    );
    this.options.changed();
  }

  private async changes(path: string): Promise<number | null> {
    const { code, stdout } = await this.run(
      { ...this.options.git, args: [...this.options.git.args, 'status', '--porcelain'] },
      path,
      () => {},
    ).done;
    return code === 0 ? stdout.split('\n').filter(Boolean).length : null;
  }

  /** A command whose output isn't shown. */
  private quiet(args: string[]) {
    const { fas } = this.options;
    return this.run({ ...fas, args: [...fas.args, ...args] }, process.cwd(), () => {}).done;
  }

  private fail(label: string, message: string) {
    this.state.task = { label, running: false, ok: false, output: [message] };
    this.options.changed();
  }

  /** Runs one command shown on the page; not ok when it failed or another one is running. */
  private async task(
    label: string,
    command: Command,
    args: string[],
    cwd: string,
    line?: (text: string) => void,
  ): Promise<{ ok: boolean; stdout: string }> {
    if (this.busy) return { ok: false, stdout: '' };
    const task = { label, running: true, ok: null as boolean | null, output: [] as string[] };
    this.state.task = task;
    this.options.changed();
    const { child, done } = this.run(
      { ...command, args: [...command.args, ...args] },
      cwd || process.cwd(),
      (text) => {
        task.output = [...task.output, text].slice(-OUTPUT_LINES);
        line?.(text);
        this.options.changed();
      },
    );
    this.child = child;
    const { code, stdout } = await done;
    this.child = null;
    task.running = false;
    task.ok = code === 0;
    this.options.changed();
    return { ok: task.ok, stdout };
  }
}

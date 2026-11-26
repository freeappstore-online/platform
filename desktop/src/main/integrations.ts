// One-click Connect / Disconnect for AI clients (#815). Each client gets a stdio entry that runs this
// app's own binary in node mode with the bundled proxy (src/stdio), so client configs hold no token.
import { execFile } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The name of our entry in every client's MCP server list. */
export const SERVER_NAME = 'freeappstore';

export interface StdioEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type ClientId = 'claude-code' | 'claude-desktop';

export interface ClientStatus {
  id: ClientId;
  name: string;
  /** The client is installed (its CLI or config was found). */
  detected: boolean;
  /** Our entry is present, pointing at this copy of the app. */
  connected: boolean;
  detail: string;
}

// ── MCP config files ({ "mcpServers": { … } }) ─────────────────────

type Json = Record<string, unknown>;

function readJson(file: string): Json | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} is not a JSON object.`);
  }
  return value as Json;
}

/** The `mcpServers` of a config file, or {} when the file or key is missing. */
export function readServers(file: string): Json {
  const servers = readJson(file)?.mcpServers;
  return servers && typeof servers === 'object' ? (servers as Json) : {};
}

/**
 * Adds (`entry`) or removes (`null`) one server in a config file, keeping everything else in it as
 * it was. Throws, leaving the file untouched, when it isn't valid JSON.
 */
export function setServer(file: string, name: string, entry: Json | null): void {
  const config = readJson(file) ?? {};
  const servers = { ...((config.mcpServers as Json | undefined) ?? {}) };
  if (entry) servers[name] = entry;
  else if (!(name in servers)) return;
  else delete servers[name];
  config.mcpServers = servers;
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.fas-tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
  renameSync(tmp, file);
}

const isOurs = (value: unknown, entry: StdioEntry) => {
  const server = value as { command?: unknown; args?: unknown } | undefined;
  return (
    server?.command === entry.command &&
    JSON.stringify(server.args ?? []) === JSON.stringify(entry.args)
  );
};

// ── Claude Code: the `claude` CLI, resolved through the user's login shell ─────

const MARK = '__FAS_DESKTOP__';

export interface ClaudeShell {
  /** Absolute path of the `claude` CLI, if found. */
  cli?: string;
  /** CLAUDE_CONFIG_DIR as the user's shell sets it. */
  configDir?: string;
  /** The shell's PATH (the CLI may need `node` from it). */
  path?: string;
}

/** Reads the marker lines printed by the login-shell probe, ignoring anything a profile prints. */
export function parseShellProbe(stdout: string): ClaudeShell {
  const values = stdout
    .split('\n')
    .filter((line) => line.startsWith(MARK))
    .map((line) => line.slice(MARK.length).trim());
  const [cli, configDir, path] = values;
  return {
    // `command -v` prints an alias or function definition for those; only a path is usable.
    ...(cli?.startsWith('/') ? { cli } : {}),
    ...(configDir ? { configDir } : {}),
    ...(path ? { path } : {}),
  };
}

/**
 * A GUI app doesn't inherit the shell's environment, so ask the user's login shell where `claude`
 * is and what CLAUDE_CONFIG_DIR and PATH are. Falls back to ~/.local/bin/claude (the installer's
 * location). Not used on Windows, which falls back to editing the config file.
 */
export function resolveClaudeShell(
  shell = process.env.SHELL || '/bin/zsh',
  home = process.env.HOME ?? '',
): Promise<ClaudeShell> {
  const probe = `printf '\\n${MARK}%s\\n${MARK}%s\\n${MARK}%s\\n' "$(command -v claude)" "$CLAUDE_CONFIG_DIR" "$PATH"`;
  return new Promise((done) => {
    execFile(shell, ['-ilc', probe], { timeout: 10_000 }, (_error, stdout) => {
      const found = parseShellProbe(String(stdout ?? ''));
      const fallback = join(home, '.local', 'bin', 'claude');
      if (!found.cli && home && existsSync(fallback)) found.cli = fallback;
      done(found);
    }).stdin?.end();
  });
}

export interface Profile {
  /** CLAUDE_CONFIG_DIR for this profile; undefined for the default (~/.claude.json). */
  dir?: string;
  /** The config file holding user-scope MCP servers. */
  file: string;
  label: string;
}

/**
 * The Claude Code config profiles on this machine: the default (~/.claude.json), the shell's
 * CLAUDE_CONFIG_DIR, and any ~/.claude-* directory holding a .claude.json (people switch profiles
 * with an alias such as `CLAUDE_CONFIG_DIR=~/.claude-work claude`, which a login shell can't see).
 */
export function claudeCodeProfiles(home: string, shellConfigDir?: string): Profile[] {
  const tilde = (path: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);
  const profiles = new Map<string, Profile>();
  const add = (dir: string | undefined) => {
    const file = resolve(dir ? join(dir, '.claude.json') : join(home, '.claude.json'));
    if (!profiles.has(file)) profiles.set(file, { dir, file, label: tilde(dir ?? file) });
  };
  if (existsSync(join(home, '.claude.json')) || existsSync(join(home, '.claude'))) add(undefined);
  if (shellConfigDir) add(shellConfigDir);
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {}
  for (const name of names.sort()) {
    const dir = join(home, name);
    if (name.startsWith('.claude-') && existsSync(join(dir, '.claude.json'))) add(dir);
  }
  return [...profiles.values()];
}

function run(cli: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((done, fail) => {
    execFile(cli, args, { env, timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error)
        fail(
          new Error(
            String(stderr || error.message)
              .trim()
              .split('\n')[0],
          ),
        );
      else done();
    }).stdin?.end();
  });
}

// ── The two clients ─────────────────────────────────────────────

export interface IntegrationOptions {
  /** The stdio entry to install: this app's binary, node mode, the proxy script. */
  entry: StdioEntry;
  /** Electron's appData directory (Claude Desktop keeps its config under it). */
  appData: string;
  home: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Status, Connect and Disconnect for Claude Code and Claude Desktop.
 *
 * Test overrides (so tests never touch real configs): FAS_DESKTOP_CLAUDE_DESKTOP_CONFIG (the
 * Claude Desktop config file), FAS_DESKTOP_CLAUDE_CLI (the `claude` CLI, skipping the login shell)
 * and FAS_DESKTOP_CLAUDE_HOME (where Claude Code profiles are looked for).
 */
export class Integrations {
  private shell: Promise<ClaudeShell> | null = null;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: IntegrationOptions) {
    this.env = options.env ?? process.env;
  }

  private get desktopConfig() {
    return (
      this.env.FAS_DESKTOP_CLAUDE_DESKTOP_CONFIG ||
      join(this.options.appData, 'Claude', 'claude_desktop_config.json')
    );
  }

  private get home() {
    return this.env.FAS_DESKTOP_CLAUDE_HOME || this.options.home;
  }

  /** Resolved once per app run (a login shell is slow); `fresh` re-resolves. */
  private claudeShell(fresh = false): Promise<ClaudeShell> {
    if (this.env.FAS_DESKTOP_CLAUDE_CLI) {
      return Promise.resolve({ cli: this.env.FAS_DESKTOP_CLAUDE_CLI });
    }
    if (process.platform === 'win32') return Promise.resolve({});
    if (fresh || !this.shell) this.shell = resolveClaudeShell(this.env.SHELL, this.options.home);
    return this.shell;
  }

  private async claudeCode(fresh = false) {
    const shell = await this.claudeShell(fresh);
    const profiles = claudeCodeProfiles(this.home, shell.configDir);
    // A CLI that has never run has no profile yet; it will use the default one.
    if (shell.cli && profiles.length === 0) {
      profiles.push({ file: join(this.home, '.claude.json'), label: '~/.claude.json' });
    }
    return { shell, profiles };
  }

  async status(): Promise<ClientStatus[]> {
    const { entry } = this.options;
    const { shell, profiles } = await this.claudeCode();
    const connectedIn = profiles.filter((p) => {
      try {
        return isOurs(readServers(p.file)[SERVER_NAME], entry);
      } catch {
        return false;
      }
    });
    const code: ClientStatus = {
      id: 'claude-code',
      name: 'Claude Code',
      detected: Boolean(shell.cli) || profiles.length > 0,
      connected: profiles.length > 0 && connectedIn.length === profiles.length,
      detail:
        profiles.length === 0
          ? 'Not found on this computer.'
          : connectedIn.length === profiles.length
            ? `Connected in ${profiles.map((p) => p.label).join(', ')}. New Claude Code sessions have it.`
            : connectedIn.length > 0
              ? `Connected in ${connectedIn.map((p) => p.label).join(', ')}; Connect adds it to ${profiles
                  .filter((p) => !connectedIn.includes(p))
                  .map((p) => p.label)
                  .join(', ')}.`
              : `Found ${profiles.map((p) => p.label).join(', ')}.`,
    };

    const file = this.desktopConfig;
    let connected = false;
    let broken = false;
    try {
      connected = isOurs(readServers(file)[SERVER_NAME], entry);
    } catch {
      broken = true;
    }
    const desktop: ClientStatus = {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      detected: existsSync(dirname(file)),
      connected,
      detail: broken
        ? "Its config file isn't valid JSON, so it can't be changed safely."
        : connected
          ? 'Connected. Quit and reopen Claude Desktop if it was open.'
          : existsSync(dirname(file))
            ? 'Found on this computer.'
            : 'Not found on this computer.',
    };
    return [code, desktop];
  }

  async connect(id: ClientId): Promise<void> {
    const { entry } = this.options;
    if (id === 'claude-desktop') {
      return setServer(this.desktopConfig, SERVER_NAME, { ...entry });
    }
    const { shell, profiles } = await this.claudeCode(true);
    const json = JSON.stringify({ type: 'stdio', ...entry });
    for (const profile of profiles) {
      if (!shell.cli) {
        setServer(profile.file, SERVER_NAME, { type: 'stdio', ...entry });
        continue;
      }
      const env = this.cliEnv(shell, profile);
      // add-json refuses to overwrite: drop an old entry (e.g. from a moved app) first.
      if (SERVER_NAME in safeServers(profile.file)) {
        await run(shell.cli, ['mcp', 'remove', '--scope', 'user', SERVER_NAME], env);
      }
      await run(shell.cli, ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, json], env);
    }
  }

  async disconnect(id: ClientId): Promise<void> {
    if (id === 'claude-desktop') return setServer(this.desktopConfig, SERVER_NAME, null);
    const { shell, profiles } = await this.claudeCode(true);
    for (const profile of profiles) {
      if (!(SERVER_NAME in safeServers(profile.file))) continue;
      if (shell.cli) {
        await run(
          shell.cli,
          ['mcp', 'remove', '--scope', 'user', SERVER_NAME],
          this.cliEnv(shell, profile),
        );
      } else {
        setServer(profile.file, SERVER_NAME, null);
      }
    }
  }

  private cliEnv(shell: ClaudeShell, profile: Profile): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env, ...(shell.path ? { PATH: shell.path } : {}) };
    if (profile.dir) env.CLAUDE_CONFIG_DIR = profile.dir;
    else delete env.CLAUDE_CONFIG_DIR;
    return env;
  }
}

function safeServers(file: string): Json {
  try {
    return readServers(file);
  } catch {
    return {};
  }
}

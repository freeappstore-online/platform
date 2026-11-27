import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WHEN } from './conditions.js';
import {
  claudeCodeProfiles,
  Integrations,
  parseShellProbe,
  readServers,
  resolveClaudeShell,
  SERVER_NAME,
  type StdioEntry,
  setServer,
} from './integrations.js';
import { loadSettings, saveSettings } from './settings.js';

const FAKE_CLAUDE = new URL('../../e2e/fixture/fake-claude.mjs', import.meta.url).pathname;
const ENTRY: StdioEntry = {
  command: '/Applications/FreeAppStore.app/Contents/MacOS/FreeAppStore',
  args: ['/Applications/FreeAppStore.app/Contents/Resources/app.asar.unpacked/dist/stdio/main.mjs'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fas-integrations-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

describe('setServer: merging into a client config file', () => {
  it('adds our entry and keeps every other key and server as it was', () => {
    const file = join(tmp, 'claude_desktop_config.json');
    const before = {
      globalShortcut: 'Cmd+Space',
      mcpServers: { other: { command: 'npx', args: ['other-mcp'] } },
      preferences: { theme: 'dark' },
    };
    writeFileSync(file, JSON.stringify(before));
    chmodSync(file, 0o640);
    setServer(file, SERVER_NAME, { ...ENTRY });
    expect(readJson(file)).toEqual({
      ...before,
      mcpServers: { other: before.mcpServers.other, [SERVER_NAME]: ENTRY },
    });
    expect(statSync(file).mode & 0o777).toBe(0o640);

    setServer(file, SERVER_NAME, null);
    expect(readJson(file)).toEqual(before);
  });

  it('creates the file when missing, and removing from a missing file does nothing', () => {
    const file = join(tmp, 'new.json');
    setServer(file, SERVER_NAME, null);
    expect(existsSync(file)).toBe(false);
    setServer(file, SERVER_NAME, { ...ENTRY });
    expect(readServers(file)).toEqual({ [SERVER_NAME]: ENTRY });
  });

  it('refuses to touch a file that is not valid JSON', () => {
    const file = join(tmp, 'broken.json');
    writeFileSync(file, '{ "mcpServers": {');
    expect(() => setServer(file, SERVER_NAME, { ...ENTRY })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{ "mcpServers": {');
  });
});

describe('finding the claude CLI', () => {
  it('reads the marker lines and ignores whatever the profile prints', () => {
    expect(
      parseShellProbe(
        'Welcome!\n(eval):1: something\n\n__FAS_DESKTOP__/Users/me/.local/bin/claude\n__FAS_DESKTOP__/Users/me/.claude-work\n__FAS_DESKTOP__/usr/bin:/bin\n',
      ),
    ).toEqual({
      cli: '/Users/me/.local/bin/claude',
      configDir: '/Users/me/.claude-work',
      path: '/usr/bin:/bin',
    });
    // An alias is not a path; an unset CLAUDE_CONFIG_DIR is no profile.
    expect(
      parseShellProbe(
        "__FAS_DESKTOP__alias claude='x'\n__FAS_DESKTOP__\n__FAS_DESKTOP__/usr/bin\n",
      ),
    ).toEqual({ path: '/usr/bin' });
  });

  it("asks the user's login shell, which sees their PATH and CLAUDE_CONFIG_DIR", async () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
    chmodSync(join(bin, 'claude'), 0o755);
    // A login shell that sets PATH and CLAUDE_CONFIG_DIR the way a profile would, then runs the probe.
    const shell = join(tmp, 'shell');
    writeFileSync(
      shell,
      `#!/bin/sh\n[ "$1" = "-ilc" ] || exit 9\necho "profile noise"\nexec env -i PATH="${bin}:/usr/bin:/bin" CLAUDE_CONFIG_DIR="${tmp}/.claude-work" /bin/sh -c "$2"\n`,
    );
    chmodSync(shell, 0o755);
    expect(await resolveClaudeShell(shell, tmp)).toEqual({
      cli: join(bin, 'claude'),
      configDir: `${tmp}/.claude-work`,
      path: `${bin}:/usr/bin:/bin`,
    });
  });

  it('falls back to ~/.local/bin/claude when the shell finds nothing', async () => {
    mkdirSync(join(tmp, '.local', 'bin'), { recursive: true });
    writeFileSync(join(tmp, '.local', 'bin', 'claude'), '');
    expect(await resolveClaudeShell('/nonexistent-shell', tmp)).toEqual({
      cli: join(tmp, '.local', 'bin', 'claude'),
    });
  });

  it('finds the default profile, the shell one and ~/.claude-* profiles', () => {
    writeFileSync(join(tmp, '.claude.json'), '{}');
    mkdirSync(join(tmp, '.claude-work'));
    writeFileSync(join(tmp, '.claude-work', '.claude.json'), '{}');
    mkdirSync(join(tmp, '.claude-empty'));
    mkdirSync(join(tmp, 'elsewhere'));
    expect(
      claudeCodeProfiles(tmp, join(tmp, 'elsewhere')).map((p) => [p.dir ?? null, p.label]),
    ).toEqual([
      [null, '~/.claude.json'],
      [join(tmp, 'elsewhere'), '~/elsewhere'],
      [join(tmp, '.claude-work'), '~/.claude-work'],
    ]);
    // The shell's dir is the same as a ~/.claude-* one: listed once.
    expect(claudeCodeProfiles(tmp, join(tmp, '.claude-work'))).toHaveLength(2);
  });
});

describe('Integrations', () => {
  const setup = (env: NodeJS.ProcessEnv) => {
    const desktopConfig = join(tmp, 'Claude', 'claude_desktop_config.json');
    const home = join(tmp, 'home');
    mkdirSync(home);
    const log = join(tmp, 'claude.log');
    const integrations = new Integrations({
      entry: ENTRY,
      appData: join(tmp, 'unused'),
      home: '/nonexistent-real-home',
      env: {
        PATH: process.env.PATH,
        FAS_DESKTOP_CLAUDE_DESKTOP_CONFIG: desktopConfig,
        FAS_DESKTOP_CLAUDE_HOME: home,
        FAS_FAKE_CLAUDE_LOG: log,
        ...env,
      },
    });
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    return { integrations, desktopConfig, home, calls };
  };

  it('connects and disconnects Claude Desktop, keeping its other servers', async () => {
    const { integrations, desktopConfig } = setup({ FAS_DESKTOP_CLAUDE_CLI: FAKE_CLAUDE });
    let [, desktop] = await integrations.status();
    expect(desktop).toMatchObject({ detected: false, connected: false });
    mkdirSync(join(tmp, 'Claude'));
    writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    [, desktop] = await integrations.status();
    expect(desktop).toMatchObject({ detected: true, connected: false });

    await integrations.connect('claude-desktop');
    expect(readServers(desktopConfig)).toEqual({ other: { command: 'x' }, [SERVER_NAME]: ENTRY });
    [, desktop] = await integrations.status();
    expect(desktop).toMatchObject({ connected: true });

    await integrations.disconnect('claude-desktop');
    expect(readServers(desktopConfig)).toEqual({ other: { command: 'x' } });
  });

  it('registers Claude Code at user scope through the CLI, in every profile', async () => {
    const { integrations, home, calls } = setup({ FAS_DESKTOP_CLAUDE_CLI: FAKE_CLAUDE });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3 }));
    const work = join(home, '.claude-work');
    mkdirSync(work);
    writeFileSync(join(work, '.claude.json'), JSON.stringify({ mcpServers: { x: {} } }));

    let [code] = await integrations.status();
    expect(code).toMatchObject({ detected: true, connected: false });
    await integrations.connect('claude-code');
    const json = JSON.stringify({ type: 'stdio', ...ENTRY });
    expect(calls()).toEqual([
      { args: ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, json], configDir: null },
      { args: ['mcp', 'add-json', '--scope', 'user', SERVER_NAME, json], configDir: work },
    ]);
    expect(readJson(join(home, '.claude.json'))).toMatchObject({ numStartups: 3 });
    expect(readServers(join(work, '.claude.json'))).toEqual({
      x: {},
      [SERVER_NAME]: { type: 'stdio', ...ENTRY },
    });
    [code] = await integrations.status();
    expect(code).toMatchObject({ connected: true });
    expect(code!.detail).toContain('~/.claude.json, ~/.claude-work');

    // Connecting again replaces the entry (remove, then add).
    await integrations.connect('claude-code');
    expect(
      calls()
        .slice(2)
        .map((c) => c.args[1]),
    ).toEqual(['remove', 'add-json', 'remove', 'add-json']);

    await integrations.disconnect('claude-code');
    expect(readServers(join(home, '.claude.json'))).toEqual({});
    expect(readServers(join(work, '.claude.json'))).toEqual({ x: {} });
  });

  it('edits the config file itself when there is no CLI', async () => {
    const { integrations, home } = setup({ FAS_DESKTOP_CLAUDE_CLI: '', SHELL: '/nonexistent' });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { a: 1 } }));
    await integrations.connect('claude-code');
    expect(readJson(join(home, '.claude.json'))).toEqual({
      projects: { a: 1 },
      mcpServers: { [SERVER_NAME]: { type: 'stdio', ...ENTRY } },
    });
    await integrations.disconnect('claude-code');
    expect(readJson(join(home, '.claude.json'))).toEqual({ projects: { a: 1 }, mcpServers: {} });
  });

  it('never touches the remote freeappstore server entry (#817)', async () => {
    const { integrations, home } = setup({ FAS_DESKTOP_CLAUDE_CLI: FAKE_CLAUDE });
    const remote = { type: 'http', url: 'https://mcp.freeappstore.online/mcp' };
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { freeappstore: remote } }),
    );
    await integrations.connect('claude-code');
    expect(readServers(join(home, '.claude.json'))).toEqual({
      freeappstore: remote,
      [SERVER_NAME]: { type: 'stdio', ...ENTRY },
    });
    await integrations.disconnect('claude-code');
    expect(readServers(join(home, '.claude.json'))).toEqual({ freeappstore: remote });
  });

  it('shows an entry pointing at another copy of the app as not connected', async () => {
    const { integrations, desktopConfig } = setup({ FAS_DESKTOP_CLAUDE_CLI: FAKE_CLAUDE });
    mkdirSync(join(tmp, 'Claude'));
    setServer(desktopConfig, SERVER_NAME, { ...ENTRY, command: '/Users/me/Downloads/old' });
    const [, desktop] = await integrations.status();
    expect(desktop).toMatchObject({ detected: true, connected: false });
  });
});

describe('settings', () => {
  const contribute = {
    contributeApps: [],
    contributeMode: 'auto',
    contributeWhen: DEFAULT_WHEN,
    contributeAccount: null,
    autoUpdate: true,
    recentApps: [],
    favoriteApps: [],
  };
  it('defaults to on and open at login on first run, and persists changes', () => {
    expect(loadSettings(tmp)).toEqual({
      settings: { paused: false, openAtLogin: true, ...contribute },
      firstRun: true,
    });
    const changed = {
      paused: true,
      openAtLogin: false,
      contributeApps: ['books'],
      contributeMode: 'off' as const,
      contributeWhen: { ...DEFAULT_WHEN, onBattery: true, minBattery: 60, cpu: 'full' as const },
      contributeAccount: 'gh:1',
      autoUpdate: false,
      recentApps: ['notes', 'books'],
      favoriteApps: ['books'],
    };
    saveSettings(tmp, changed);
    expect(loadSettings(tmp)).toEqual({ settings: changed, firstRun: false });
    // Settings saved before Contribute (#826) get its defaults
    writeFileSync(join(tmp, 'settings.json'), '{"paused":true,"contributeApps":[1,"books"]}');
    expect(loadSettings(tmp).settings).toEqual({
      ...contribute,
      paused: true,
      openAtLogin: true,
      contributeApps: ['books'],
    });
    // Pause before #830 is Off; conditions saved wrong keep their defaults
    writeFileSync(
      join(tmp, 'settings.json'),
      JSON.stringify({
        contributePaused: true,
        contributeWhen: { minBattery: 'x', inUse: 'slower' },
      }),
    );
    expect(loadSettings(tmp).settings).toMatchObject({
      contributeMode: 'off',
      contributeWhen: { ...DEFAULT_WHEN, inUse: 'slower' },
    });
    expect(loadSettings(tmp).settings).not.toHaveProperty('contributePaused');
    writeFileSync(join(tmp, 'settings.json'), 'garbage');
    expect(loadSettings(tmp).settings).toEqual({ paused: false, openAtLogin: true, ...contribute });
  });
});

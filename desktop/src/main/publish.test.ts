import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Command,
  type MyApp,
  Publisher,
  parseChecks,
  parseDeviceCode,
  parseMyApps,
  parseWhoami,
  publishArgs,
  pushUrl,
  type Run,
  readAppId,
} from './publish.js';

const app = (id: string, repoUrl = `https://github.com/freeappstore-online/${id}`): MyApp => ({
  id,
  oneliner: 'Tides',
  category: 'Utilities',
  appUrl: `https://${id}.freeappstore.online`,
  repoUrl,
});

describe('the CLI output', () => {
  it('reads the device code fas login prints, from GitHub only', () => {
    expect(
      parseDeviceCode('\nOpen https://github.com/login/device and enter code: AB12-CD34\n'),
    ).toEqual({ url: 'https://github.com/login/device', code: 'AB12-CD34' });
    expect(parseDeviceCode('Open https://evil.example/device and enter code: X')).toBeNull();
    expect(parseDeviceCode('Waiting for authorization...')).toBeNull();
  });

  it('reads fas whoami', () => {
    expect(parseWhoami(0, '@octo\nSession: active, expires in 12 days.\n')).toEqual({
      login: 'octo',
      expired: false,
    });
    expect(parseWhoami(0, '@octo\nSession: expired — run `fas login` to refresh.\n')).toEqual({
      login: 'octo',
      expired: true,
    });
    expect(parseWhoami(0, '@octo\nSession: none — run `fas login`\n')).toBeNull();
    expect(parseWhoami(1, 'Not signed in. Run: fas login\n')).toBeNull();
  });

  it('keeps only the fields the page shows from /v1/apps/mine', () => {
    const body = { apps: [{ ...app('tides'), ownerLogin: 'octo', createdAt: 1 }] };
    expect(parseMyApps(JSON.stringify(body))).toEqual([app('tides')]);
  });

  it('reads fas check --json, or null when it printed something else', () => {
    const results = [{ name: 'MIT License', status: 'pass', detail: 'LICENSE' }];
    expect(parseChecks(JSON.stringify(results))).toEqual(results);
    expect(parseChecks('fas: no package.json')).toBeNull();
  });
});

describe('publishArgs', () => {
  it('builds a non-interactive fas publish', () => {
    expect(publishArgs('tides', { category: 'Utilities', oneliner: '  Tide   times ' })).toEqual([
      'publish',
      '--yes',
      '--name',
      'tides',
      '--category',
      'Utilities',
      '--type',
      'standalone',
      '--oneliner',
      'Tide times',
    ]);
  });

  it('refuses what the CLI would prompt for or could read as an option', () => {
    expect(publishArgs('--help', { category: 'Utilities', oneliner: 'x' })).toMatch(/app id/);
    expect(publishArgs('tides', { category: 'Games', oneliner: 'x' })).toMatch(/category/);
    expect(publishArgs('tides', { category: 'Utilities', oneliner: ' ' })).toMatch(/one-line/);
    expect(publishArgs('tides', { category: 'Utilities', oneliner: 'x'.repeat(201) })).toMatch(
      /under 200/,
    );
  });
});

describe('pushUrl', () => {
  it("pushes only to the app's own repository in the org", () => {
    expect(pushUrl(app('tides'), false)).toBe('https://github.com/freeappstore-online/tides.git');
    expect(pushUrl(app('tides', 'https://github.com/someone/tides'), false)).toBeNull();
    expect(pushUrl(app('tides', 'https://github.com/freeappstore-online/other'), false)).toBeNull();
  });

  it('takes the stand-in API’s repository in dev builds', () => {
    expect(pushUrl(app('tides', 'file:///tmp/tides'), true)).toBe('file:///tmp/tides.git');
  });
});

describe('Publisher', () => {
  let dir: string;
  let project: string;
  let projects: string[];
  let calls: string[];
  let replies: Record<string, { code: number; stdout: string }>;
  let opened: string[];

  const fake: Run = (command: Command, cwd, line) => {
    const key = [command.command, ...command.args].join(' ');
    calls.push(`${key} @${cwd}`);
    const reply = Object.entries(replies).find(([prefix]) => key.includes(prefix))?.[1] ?? {
      code: 0,
      stdout: '',
    };
    for (const text of reply.stdout.split('\n')) line(text);
    return { child: null, done: Promise.resolve(reply) };
  };

  const publisher = () =>
    new Publisher({
      fas: { command: 'electron', args: ['fas.mjs'], env: {} },
      git: { command: 'git', args: [], env: {} },
      dev: false,
      projects: () => projects,
      saveProjects: (paths) => {
        projects = paths;
      },
      open: (url) => opened.push(url),
      changed: () => {},
      run: fake,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fas-publish-'));
    project = join(dir, 'tides');
    mkdirSync(project);
    writeFileSync(join(project, 'fas.json'), '{"appId":"tides"}');
    projects = [];
    calls = [];
    opened = [];
    replies = {
      whoami: { code: 0, stdout: '@octo\nSession: active, expires in 30 days.\n' },
      '--my-apps': { code: 0, stdout: JSON.stringify({ apps: [app('tides')] }) },
      'status --porcelain': { code: 0, stdout: '' },
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads fas.json app ids', () => {
    expect(readAppId(project)).toBe('tides');
    expect(readAppId(dir)).toBeNull();
  });

  it('shows the device code and opens GitHub while fas login waits', async () => {
    replies.login = {
      code: 0,
      stdout: 'Open https://github.com/login/device and enter code: AB12-CD34\nWaiting…',
    };
    const p = publisher();
    await p.signIn();
    expect(opened).toEqual(['https://github.com/login/device']);
    expect(p.state.signIn).toBeNull();
    expect(p.state.account).toEqual({ login: 'octo', expired: false });
    expect(p.state.apps).toEqual([app('tides')]);
  });

  it('adds only app folders and creates apps with fas init', async () => {
    const p = publisher();
    expect(await p.add(dir)).toBe(false);
    expect(await p.add(project)).toBe(true);
    expect(projects).toEqual([project]);
    expect(await p.create(dir, '-rf')).toBe(false);
    expect(calls.some((c) => c.includes('init'))).toBe(false);
    mkdirSync(join(dir, 'moon'));
    writeFileSync(join(dir, 'moon', 'fas.json'), '{"appId":"moon"}');
    expect(await p.create(dir, 'moon')).toBe(true);
    expect(calls).toContain(`electron fas.mjs init moon @${dir}`);
    expect(projects).toEqual([project, join(dir, 'moon')]);
  });

  it('publishes with the app id from fas.json', async () => {
    const p = publisher();
    await p.add(project);
    expect(await p.publish(project, { category: 'Utilities', oneliner: 'Tide times' })).toBe(true);
    expect(calls).toContain(
      `electron fas.mjs publish --yes --name tides --category Utilities --type standalone --oneliner Tide times @${project}`,
    );
  });

  it('pushes only a published app, committing changes with a message first', async () => {
    const p = publisher();
    await p.add(project);
    expect(await p.push(project, '')).toBe(false);
    expect(p.state.task?.output).toEqual(['Publish this app first: it has no repository yet.']);

    await p.refresh();
    replies['status --porcelain'] = { code: 0, stdout: ' M web/src/App.tsx\n' };
    expect(await p.push(project, ' ')).toBe(false);
    expect(p.state.task?.output).toEqual(['Describe your changes, then push.']);
    calls = [];
    expect(await p.push(project, 'Dark mode')).toBe(true);
    expect(calls.filter((c) => !c.includes('status'))).toEqual([
      `git add -A @${project}`,
      `git commit -q -m Dark mode @${project}`,
      `git push https://github.com/freeappstore-online/tides.git main @${project}`,
    ]);
  });

  it('shows check results and the failed command', async () => {
    const p = publisher();
    await p.add(project);
    replies['check --json'] = {
      code: 1,
      stdout: JSON.stringify([{ name: 'MIT License', status: 'fail', detail: 'missing' }]),
    };
    await p.check(project);
    expect(p.state.projects[0]?.checks).toEqual([
      { name: 'MIT License', status: 'fail', detail: 'missing' },
    ]);
    expect(p.state.task).toMatchObject({ label: 'Check', running: false, ok: false });
  });
});

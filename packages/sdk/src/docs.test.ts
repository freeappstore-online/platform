// The docs present Shell as the standard way to build a FreeAppStore app (#90,
// #92). These checks keep them honest as the SDK changes: every documented UI
// export exists, every Shell prop is documented, no doc teaches the old
// hand-rolled shell, and the developer docs' links resolve.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const uiDoc = read('../../../docs/ui.md');
const readme = read('../README.md');
const gettingStarted = read('../../../docs/getting-started.md');
const layout = read('./ui/layout.tsx');

/** Value names (not `type` imports) in every `import { … } from '@freeappstore/sdk/ui'` of a doc. */
function documentedImports(doc: string): string[] {
  const blocks = [...doc.matchAll(/import \{([^}]+)\} from '@freeappstore\/sdk\/ui'/g)].map(
    (m) => m[1],
  );
  return blocks
    .join(',')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join(',')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name && !name.startsWith('type '));
}

/** Section of a markdown doc from `heading` to the next heading of the same level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  const level = heading.match(/^#+/)?.[0] ?? '##';
  const rest = doc.slice(start + heading.length);
  const end = rest.search(new RegExp(`\n${level} `));
  return end === -1 ? rest : rest.slice(0, end);
}

describe('UI docs match the SDK', () => {
  it.each([
    ['docs/ui.md', uiDoc],
    ['packages/sdk/README.md', readme],
  ])('every name %s imports from @freeappstore/sdk/ui is exported', async (_name, doc) => {
    const ui = await import('./ui/index.js');
    const names = documentedImports(doc);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => !(n in ui))).toEqual([]);
  });

  it('documents every Shell prop', () => {
    const props = /export interface ShellProps \{([\s\S]*?)\n\}/.exec(layout)?.[1] ?? '';
    const names = [...props.matchAll(/^ {2}(\w+)\??:/gm)]
      .map((m) => m[1])
      .filter((n) => n !== 'children');
    expect(names).toContain('nav');
    const table = section(uiDoc, '### Props');
    expect(names.filter((n) => !table.includes(`\`${n}`))).toEqual([]);
  });
});

describe('Shell is the documented standard path', () => {
  const shell = section(uiDoc, '## Shell: the standard app frame');

  it('ui.md leads with Shell and shows it with nav', () => {
    expect(uiDoc.indexOf('## Shell: the standard app frame')).toBeLessThan(
      uiDoc.indexOf('## Auth & Identity'),
    );
    expect(shell).toMatch(/<Shell app=\{fas\} appName="[^"]+" nav=\{NAV\}/);
    for (const part of ['PageHeader', 'useToast', 'onNavigate', '<nav aria-label="Main">']) {
      expect(shell).toContain(part);
    }
  });

  it('says FAS has no subscription gate', () => {
    expect(shell).toMatch(/no subscription or upgrade screen/);
  });

  it('getting started and the SDK README point new apps at Shell', () => {
    expect(gettingStarted).toContain('ui.md#shell-the-standard-app-frame');
    expect(readme).toContain('### App shell');
    expect(readme).toMatch(/<Shell app=\{fas\} appName="[^"]+" nav=\{NAV\}/);
  });
});

// ── Documentation sweep (#92) ───────────────────────────────────

const root = new URL('../../../', import.meta.url).pathname;
const readRoot = (path: string) => readFileSync(join(root, path), 'utf8');

/** Every tracked markdown doc, minus changelogs and test fixtures. */
const trackedDocs = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.includes('CHANGELOG') && !f.includes('test/fixtures'));

/** The developer-facing docs: the docs site, the READMEs developers land on, and the AI guides. */
const DEVELOPER_DOCS = [
  'docs/index.md',
  'docs/getting-started.md',
  'docs/sdk.md',
  'docs/ui.md',
  'docs/cli.md',
  'docs/publishing.md',
  'docs/proxy-and-keys.md',
  'docs/platform-limits.md',
  'docs/architecture.md',
  'docs/mcp.md',
  'README.md',
  'packages/sdk/README.md',
  'packages/cli/README.md',
  'workers/mcp/README.md',
  'brand/BRAND.md',
  'brand/SKILLS.md',
  'ops/SKILLS.md',
];

const withoutCode = (md: string) => md.replace(/```[\s\S]*?```/g, '');

/** GitHub / MkDocs heading anchor. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');

const anchorsOf = (path: string) =>
  new Set(
    [...withoutCode(readRoot(path)).matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => slug(m[1] ?? '')),
  );

describe('documentation sweep (#92)', () => {
  it('covers every page the docs site publishes', () => {
    const workflow = readRoot('.github/workflows/publish-docs.yml');
    const pages = [...workflow.matchAll(/^\s+- [^:]+: ([\w-]+\.md)$/gm)].map((m) => `docs/${m[1]}`);
    expect(pages).toEqual(expect.arrayContaining(['docs/getting-started.md', 'docs/ui.md']));
    for (const page of pages) {
      expect(existsSync(join(root, page)), page).toBe(true);
      expect(DEVELOPER_DOCS).toContain(page);
    }
  });

  it('relative links and #anchors in the developer docs resolve', () => {
    const broken: string[] = [];
    for (const doc of DEVELOPER_DOCS) {
      for (const [, link = ''] of withoutCode(readRoot(doc)).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(link)) continue;
        const [path = '', fragment] = link.split('#');
        const target = path ? join(dirname(doc), path) : doc;
        if (!existsSync(join(root, target))) broken.push(`${doc} → ${link} (no file)`);
        else if (fragment && target.endsWith('.md') && !anchorsOf(target).has(fragment)) {
          broken.push(`${doc} → ${link} (no heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('no doc teaches the old hand-rolled shell or its tokens', () => {
    const stale = [
      /components\/Shell\.tsx/,
      /sidebar \(17rem\)/i,
      /Sidebar desktop \+ dock/i,
      /Shell component \(sidebar/i,
      /Bottom Dock/,
      /--dock:/,
      /Navigation dock/i,
    ];
    const findings: string[] = [];
    for (const doc of trackedDocs) {
      // The migration guide names the old layout on purpose.
      const text = readRoot(doc).replace(/### Migrating to the Shell[\s\S]*?(?=\n### )/, '');
      text.split('\n').forEach((line, i) => {
        for (const re of stale) if (re.test(line)) findings.push(`${doc}:${i + 1} ${line.trim()}`);
        // Token lists may name the banned aliases only after "never".
        if (
          /CSS Variables:/.test(line) &&
          /`--(glass|dock|error|bg|surface|border)`/.test(line.split('never')[0] ?? '')
        ) {
          findings.push(`${doc}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(findings).toEqual([]);
  });

  it('every Shell example in the docs (a tag with props) is given nav items', () => {
    const findings: string[] = [];
    for (const doc of trackedDocs) {
      for (const [tag] of readRoot(doc).matchAll(/<(?:Fas)?Shell\s[^>]*>/g)) {
        if (!tag.includes('nav=')) findings.push(`${doc}: ${tag}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it('the docs home and README lead to the canonical build guide', () => {
    const guide = '#build-your-app-on-the-shell';
    expect(readRoot('docs/index.md')).toMatch(
      new RegExp(`Start here: \\[[^\\]]+\\]\\(getting-started\\.md${guide}\\)`),
    );
    expect(readRoot('README.md')).toContain(`docs/getting-started.md${guide}`);
    const build = section(gettingStarted, '## Build your app on the Shell');
    expect(gettingStarted.indexOf('## Build your app on the Shell')).toBeLessThan(
      gettingStarted.indexOf('## Templates'),
    );
    expect(build).toMatch(/<Shell app=\{fas\} appName="[^"]+" nav=\{NAV\}/);
    for (const part of ['<nav aria-label="Main">', 'PageHeader', 'useToast', 'no subscription']) {
      expect(build, part).toContain(part);
    }
  });

  it('the Shell docs cover migration and verified caveats', () => {
    const migrating = section(uiDoc, '### Migrating to the Shell');
    expect(migrating).toMatch(/\^0\.14\.30/);
    expect(migrating).toContain('components/Shell.tsx');
    const caveats = section(uiDoc, '### Caveats');
    for (const part of [
      'render errors only',
      'useToast must be used inside <Shell>',
      'onNavigate',
      'requireAuth',
    ]) {
      expect(caveats, part).toContain(part);
    }
  });
});

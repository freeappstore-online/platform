// The docs present Shell as the standard way to build a FreeAppStore app (#90).
// These checks keep them honest as the SDK changes: every documented UI export
// exists, and every Shell prop is documented.

import { readFileSync } from 'node:fs';
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

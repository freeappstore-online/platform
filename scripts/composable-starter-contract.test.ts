/**
 * #343: the composable starter contract stays the layout/ownership rule, and
 * platform-facing guides do not put SignInButton or ProfileMenu back in the
 * Shell header or ban custom frames outright.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const GUIDES = [
  'docs/ui.md',
  'docs/getting-started.md',
  'docs/cli.md',
  'docs/architecture.md',
  'docs/index.md',
  'docs/adr/001-tailwind-on-fas-tokens.md',
  'sites/storefront/SKILLS.md',
  'sites/storefront/claude-code.md',
  'brand/BRAND.md',
  'brand/SKILLS.md',
  'README.md',
  'packages/sdk/README.md',
  'workers/mcp/README.md',
  'workers/mcp/src/sdk-reference.ts',
  'workers/agent/src/template.ts',
];

const STALE = [
  'ProfileMenu (or SignInButton when signed out)',
  'enabled in the Shell header',
  'sign-in / profile menu',
  'Default keeps the dropdown',
  'existing profile dropdown remains',
  'Never build your own header, sidebar, tab bar or bottom dock',
  "Apps don't draw their own header",
];

describe('composable starter contract (#343)', () => {
  const contract = read('docs/composable-starter-contract.md');

  it('defines one foundation, presets, ownership, and the behaviour contracts', () => {
    for (const part of [
      'One foundation',
      '`standalone`',
      '`connected`',
      'fas.capabilities.json',
      'ProfilePage',
      'user-scalable=no',
      "registerType: 'autoUpdate'",
      'fas.collections',
      'fas.rooms',
      'Device-local',
      'Private-account',
      'Public-shared',
    ]) {
      expect(contract, part).toContain(part);
    }
  });

  it('names #318, #326, and #327 without restarting fleet migration or fail-mode', () => {
    expect(contract).toContain('#318');
    expect(contract).toContain('#326');
    expect(contract).toContain('#327');
    expect(contract).toMatch(/does not restart #326/);
    expect(contract).toMatch(/does not change `css-discipline`/);
    expect(contract).toMatch(/sibling stores/);
    expect(contract).toMatch(/warn-only styling checks to fail/);
  });

  it('lists every later child and the file each one extends', () => {
    for (const issue of [344, 345, 346, 347, 348, 349, 350, 351, 352, 353]) {
      expect(contract).toContain(`#${issue}`);
    }
    for (const path of [
      'workers/agent/src/build-sanity.ts',
      'packages/cli/src/lib/capabilities.ts',
      'packages/cli/src/commands/init.ts',
      'packages/sdk/src/ui/layout.tsx',
    ]) {
      expect(contract, path).toContain(path);
    }
  });

  it('publishes the contract with the other developer docs', () => {
    expect(read('.github/workflows/publish-docs.yml')).toContain('composable-starter-contract.md');
    expect(read('packages/sdk/src/docs.test.ts')).toContain('docs/composable-starter-contract.md');
  });

  it('keeps generator and platform guides off the old header and dropdown claims', () => {
    for (const path of GUIDES) {
      const text = read(path);
      expect(text, path).toMatch(/composable starter contract/i);
      for (const phrase of STALE) {
        expect(text, `${path} still says ${phrase}`).not.toContain(phrase);
      }
    }
  });
});

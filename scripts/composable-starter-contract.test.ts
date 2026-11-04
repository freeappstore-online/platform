/**
 * The published starter contract describes shipped generation, ownership,
 * safe data boundaries, and preserves app-owned layout choices.
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
      'One canonical foundation',
      '`standalone`',
      '`connected`',
      '.fas-capabilities.json',
      'ProfilePage',
      'fas.collections',
      'fas.rooms',
      'Device-local',
      'Private account',
      'Public shared',
      'custom frame',
      'zoom',
      "reason: 'rollback'",
    ]) {
      expect(contract, part).toContain(part);
    }
    expect(contract).toContain('Keep browser page zoom enabled');
  });

  it('publishes the contract with the other developer docs', () => {
    expect(read('.github/workflows/publish-docs.yml')).toContain('composable-starter-contract.md');
    expect(read('.github/workflows/publish-docs.yml')).toContain('starter-release.md');
    expect(read('packages/sdk/src/docs.test.ts')).toContain('docs/composable-starter-contract.md');
  });

  it('preserves the styling and fleet-migration scope boundary', () => {
    expect(contract).toContain('#318');
    expect(contract).toContain('ADR-001');
    expect(contract).toContain('#327');
    expect(contract).toMatch(/does not restart #326/);
    expect(contract).toMatch(/warn-only styling checks to fail/);
    expect(contract).toMatch(/edit sibling stores/);
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

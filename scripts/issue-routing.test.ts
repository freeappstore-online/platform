/**
 * Tests that the documented platform/app issue-routing policy is consistently
 * stated in CONTRIBUTING.md and AGENTS.md,
 * and that no platform workflow creates issues in a hard-coded non-platform repo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

function read(rel: string) {
  return readFileSync(join(root, rel), 'utf8');
}

describe('issue routing policy', () => {
  it('CONTRIBUTING.md documents where app issues belong', () => {
    const text = read('CONTRIBUTING.md');
    expect(text).toMatch(/app.*issues.*belong|where issues belong/i);
    expect(text).toMatch(/freeappstore-online\/<app-id>/);
  });

  it('AGENTS.md documents the app-vs-platform split', () => {
    const text = read('AGENTS.md');
    expect(text).toMatch(/app.*issues?|where issues/i);
    expect(text).toMatch(/freeappstore-online\/<app-id>/);
  });

  it('platform alert workflows only open issues in the platform repo (context.repo.repo)', () => {
    const e2e = read('.github/workflows/prod-platform-e2e.yml');
    const smoke = read('.github/workflows/prod-smoke.yml');
    // Neither workflow should hard-code a foreign repo name for issue creation
    for (const [name, text] of [
      ['prod-platform-e2e', e2e],
      ['prod-smoke', smoke],
    ]) {
      const issueCreateBlocks = text.match(/issues\.create[\s\S]{0,400}/g) ?? [];
      expect(issueCreateBlocks.length, `${name} should still open an alert issue`).toBeGreaterThan(
        0,
      );
      for (const block of issueCreateBlocks) {
        expect(block, `${name} must not hard-code a non-platform repo`).not.toMatch(
          /repo:\s*['"`][^'"`]+['"`]/,
        );
      }
    }
  });
});

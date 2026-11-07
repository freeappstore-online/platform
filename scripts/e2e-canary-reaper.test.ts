import { expect, it, vi } from 'vitest';
// @ts-expect-error Plain Node ESM helper used outside the build.
import { leakedCanaries, reapLeakedCanaries } from './e2e-canary-reaper.mjs';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const repo = (name: string, minutes: number) => ({ name, created_at: ago(minutes) });

it('selects only canary-named repos older than one hour', () => {
  const repos = [
    repo('e2e-canary-mvlx5avfk0zc', 60 * 24 * 14), // leaked two weeks ago
    repo('e2e-canary-fresh1234', 10), // a concurrent run's canary
    repo('e2e-canary-justover1', 61),
    repo('e2e-canary-exactly1h', 60), // boundary: not older than 1h
    repo('e2e-canary-', 500), // no id
    repo('e2e-canary-UPPER', 500),
    repo('e2e-canary-toolongtoolongtoolongtoolong', 500),
    repo('e2e-fix-check', 500), // a fixture, not a canary
    repo('timer', 500),
  ];
  expect(leakedCanaries(repos, NOW).map((r: { name: string }) => r.name)).toEqual([
    'e2e-canary-mvlx5avfk0zc',
    'e2e-canary-justover1',
  ]);
});

it('uses the injected clock, not the real one', () => {
  const repos = [repo('e2e-canary-aaaa1111', 0)];
  expect(leakedCanaries(repos, NOW)).toEqual([]);
  expect(leakedCanaries(repos, NOW + 2 * 60 * 60_000)).toHaveLength(1);
});

it('unpublishes each leaked canary and keeps going after a failure', async () => {
  const unpublish = vi.fn(async (id: string) => {
    if (id === 'e2e-canary-bad00000') throw new Error('unpublish returned 502');
  });
  const log = vi.fn();
  const result = await reapLeakedCanaries({
    listRepos: async () => [
      repo('e2e-canary-bad00000', 300),
      repo('e2e-canary-good0000', 300),
      repo('e2e-canary-fresh000', 5),
      repo('timer', 9999),
    ],
    unpublish,
    now: NOW,
    log,
  });
  expect(unpublish.mock.calls.map((c) => c[0])).toEqual([
    'e2e-canary-bad00000',
    'e2e-canary-good0000',
  ]);
  expect(result).toEqual({
    reaped: ['e2e-canary-good0000'],
    failed: [{ id: 'e2e-canary-bad00000', reason: 'unpublish returned 502' }],
  });
});

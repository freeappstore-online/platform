import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkRepo, findSharedPromises } from './check-worker-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('worker shared-state guard (#641)', () => {
  it('flags the in-flight registry promise that threw 1101 (#639)', () => {
    const old = `let cached: { apps: PublicApp[]; expires: number } | undefined;
let loading: Promise<PublicApp[]> | undefined;

export async function publicApp(route: Route) {
  loading ??= (async () => [])();
  return loading;
}`;
    expect(findSharedPromises(old)).toEqual(['2: module-scope let loading holds a Promise']);
  });

  it('flags ??= on an untyped binding and a Map of in-flight promises', () => {
    expect(
      findSharedPromises('let pending;\nexport const f = () => (pending ??= load());'),
    ).toEqual(['1: module-scope let pending is assigned with ??=']);
    expect(
      findSharedPromises('const inflightRefresh = new Map<string, Promise<string>>();'),
    ).toEqual(['1: module-scope Map of Promises']);
  });

  it('allows plain-data caches, indented locals, and an explicit opt-out', () => {
    const ok = `let cached: { at: number } | null = null;
const tokens = new Map<string, { token: string }>();
function f() {
  let p: Promise<void> | undefined;
  p ??= Promise.resolve();
}
// worker-state-ok: Durable Object singleton, one request context
let ready: Promise<void> | undefined;
let other: Promise<void> | undefined; // worker-state-ok: same
`;
    expect(findSharedPromises(ok)).toEqual([]);
  });

  it('passes the fixed proxy-oauth2 token cache (#641)', () => {
    const fixed = readFileSync(
      new URL('../packages/backend/src/lib/proxy-oauth2.ts', import.meta.url),
      'utf8',
    );
    expect(findSharedPromises(fixed)).toEqual([]);
  });

  it('passes on every Worker in this repo', () => {
    expect(checkRepo(root)).toEqual([]);
  });
});

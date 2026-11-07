import { expect, it } from 'vitest';
// @ts-expect-error Plain Node ESM helper used outside the build.
import { auditFleet, formatReport, repoRef, workflowProblems } from './fleet-consistency-audit.mjs';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const OLD = Date.parse('2026-10-01T00:00:00Z');
const KEYLESS = 'jobs:\n  build:\n  deploy:\n    permissions:\n      id-token: write\n';
const ALLOW = ['platform', 'ci-workflows', 'submissions', 'vibe-check', 'ai', 'vault'];

const healthy = (name: string) => ({
  name,
  createdAt: OLD,
  empty: false,
  deployYml: KEYLESS,
  fasAppId: name,
});
const entry = (id: string, extra = {}) => ({
  id,
  repo: `freeappstore-online/${id}`,
  appUrl: `https://${id}.freeappstore.online`,
  ...extra,
});
const codes = (findings: { code: string; id: string }[]) =>
  findings.map((f) => `${f.code}:${f.id}`);

const audit = (input: Record<string, unknown>) =>
  auditFleet({ repos: [], registry: [], allowlist: ALLOW, now: NOW, ...input }) as {
    code: string;
    id: string;
    detail: string;
  }[];

it('is clean for a consistent fleet and ignores allowlisted tooling repos', () => {
  expect(
    audit({
      repos: [healthy('timer'), { ...healthy('platform'), deployYml: null }],
      registry: [entry('timer')],
      siteStatus: { timer: 200 },
    }),
  ).toEqual([]);
});

it('flags the renamed repo: registry id spending points at a repo that is now gcp-spending', () => {
  const findings = audit({
    repos: [healthy('gcp-spending')],
    registry: [entry('spending')],
    siteStatus: { spending: 200 },
  });
  expect(codes(findings)).toEqual([
    'registry-without-repo:spending',
    'repo-without-registry:gcp-spending',
  ]);
});

it('flags pulse-stack: an old empty repo that the registry still lists with a dead site', () => {
  const findings = audit({
    repos: [{ ...healthy('pulse-stack'), empty: true, deployYml: null, fasAppId: null }],
    registry: [entry('pulse-stack')],
    siteStatus: { 'pulse-stack': 404 },
  });
  expect(codes(findings)).toEqual(['listed-site-not-200:pulse-stack', 'repo-empty:pulse-stack']);
});

it('does not flag an empty repo younger than 24 hours, nor a pending listing with no site yet', () => {
  expect(
    audit({
      repos: [
        { ...healthy('new-app'), empty: true, deployYml: null, createdAt: NOW - 3_600_000 },
      ],
      registry: [entry('new-app', { discoveryStatus: 'pending' })],
      siteStatus: { 'new-app': 404 },
    }),
  ).toEqual([]);
});

it('flags a repo without a workflow, a legacy R2 workflow, and an fas.json appId mismatch', () => {
  const findings = audit({
    repos: [
      { ...healthy('sky-check'), deployYml: null },
      { ...healthy('old-app'), deployYml: 'env: ${{ secrets.R2_ACCESS_KEY_ID }}' },
      { ...healthy('renamed'), fasAppId: 'other-name' },
    ],
    registry: [entry('sky-check'), entry('old-app'), entry('renamed')],
  });
  expect(codes(findings)).toEqual([
    'fas-json-appid-mismatch:renamed',
    'repo-legacy-workflow:old-app',
    'repo-no-deploy-workflow:sky-check',
  ]);
});

it('flags a registry repo that is not the org repo for its id', () => {
  const findings = audit({
    repos: [healthy('typeflow')],
    registry: [entry('typeflow', { repo: 'abid8195/typeflow' })],
  });
  expect(codes(findings)).toContain('registry-repo-mismatch:typeflow');
});

it('flags every D1 inconsistency when the admin API data is available', () => {
  const app = (id: string, over = {}) => ({
    id,
    owner: 'serge-ivo',
    repo: `freeappstore-online/${id}`,
    hasRoute: true,
    r2Prefix: `apps/${id}`,
    ...over,
  });
  const findings = audit({
    repos: ['ok', 'fork', 'noroute', 'badprefix', 'norow'].map(healthy),
    registry: ['ok', 'fork', 'noroute', 'badprefix', 'norow'].map((id) => entry(id)),
    adminApps: [
      app('ok'),
      app('fork', { repo: 'https://github.com/someone/fork' }),
      app('noroute', { hasRoute: false, r2Prefix: null }),
      app('badprefix', { r2Prefix: 'apps/other' }),
      { id: 'orphan-route', owner: null, hasRoute: true, repo: 'freeappstore-online/orphan-route' },
    ],
  });
  expect(codes(findings)).toEqual([
    'apps-repo-not-org:fork',
    'apps-without-route:noroute',
    'repo-without-apps-row:norow',
    'route-prefix-wrong:badprefix',
    'route-without-apps:orphan-route',
  ]);
});

it('skips the D1 checks without admin data', () => {
  expect(audit({ repos: [healthy('timer')], registry: [entry('timer')] })).toEqual([]);
});

it('normalises repo references and detects non-keyless workflows', () => {
  expect(repoRef('https://github.com/FreeAppStore-Online/Timer.git')).toBe('freeappstore-online/timer');
  expect(repoRef('freeappstore-online/timer')).toBe('freeappstore-online/timer');
  expect(repoRef(null)).toBeNull();
  expect(workflowProblems(KEYLESS)).toEqual([]);
  expect(workflowProblems('# secrets.R2_X in a comment\njobs: {}')).toEqual(['lacks id-token: write']);
});

it('formats a report grouped by finding, and a clean one', () => {
  expect(formatReport([], [])).toBe('Fleet consistency audit: clean.\n');
  const report = formatReport([{ code: 'repo-empty', id: 'x', detail: 'd' }], ['n']);
  expect(report).toContain('### repo-empty (1)');
  expect(report).toContain('- `x`: d');
  expect(report).toContain('_Note: n_');
});

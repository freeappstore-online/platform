import { describe, expect, it, vi } from 'vitest'
import {
  type AdminStep,
  type DeployRun,
  type DeployStatus,
  deriveBadge,
  describeRun,
  fetchAppDeployStatus,
  fetchOwnedDeployStatuses,
  formatTimeAgo,
  formatTimestamp,
  summarizeSteps,
} from './deploy-status'

const status = (over: Partial<DeployStatus> = {}): DeployStatus => ({
  status: 'completed',
  conclusion: 'success',
  at: '2026-09-09T10:00:00Z',
  sha: 'abc1234',
  url: 'https://github.com/freeappstore-online/demo/actions/runs/42',
  branch: 'main',
  neverDeployed: false,
  ...over,
})

const json = (body: unknown, init: ResponseInit = { status: 200 }) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json' },
  })

describe('deriveBadge', () => {
  it('reports a successful deploy as live, with a link to the run', () => {
    const badge = deriveBadge(status())
    expect(badge).toMatchObject({ tone: 'success', label: 'Live' })
    expect(badge.href).toBe('https://github.com/freeappstore-online/demo/actions/runs/42')
    expect(badge.at).toBe('2026-09-09T10:00:00Z')
  })

  it('reports a failure and keeps the direct run link', () => {
    const badge = deriveBadge(status({ conclusion: 'failure' }))
    expect(badge.tone).toBe('failure')
    expect(badge.label).toBe('Deploy failed')
    // AC: the badge links to the specific run, not the repo's Actions tab.
    expect(badge.href).toContain('/actions/runs/42')
  })

  it('distinguishes "never deployed" from "we could not tell"', () => {
    // These two used to be the same blank badge, which is the bug: an app that
    // has never deployed looked identical to a rate-limited GitHub call.
    const never = deriveBadge(status({ neverDeployed: true, conclusion: null, status: null }))
    expect(never.label).toBe('Not deployed yet')

    const unknown = deriveBadge(null)
    expect(unknown.label).toBe('Deploy status unavailable')

    expect(never.label).not.toBe(unknown.label)
  })

  it('treats an in-flight run as deploying even though it has no conclusion', () => {
    for (const s of ['in_progress', 'queued', 'waiting']) {
      expect(deriveBadge(status({ status: s, conclusion: null })).tone).toBe('progress')
    }
  })

  it('does not claim a run is live when it completed with no conclusion', () => {
    const badge = deriveBadge(status({ status: 'completed', conclusion: null }))
    expect(badge.tone).not.toBe('success')
    expect(badge.label).toBe('Deploy status unavailable')
  })

  it('treats a timeout as a failure, not an unknown', () => {
    expect(deriveBadge(status({ conclusion: 'timed_out' })).tone).toBe('failure')
  })

  it('reports a cancelled deploy neutrally rather than as a failure', () => {
    const badge = deriveBadge(status({ conclusion: 'cancelled' }))
    expect(badge.tone).toBe('neutral')
    expect(badge.label).toBe('Deploy cancelled')
  })
})

describe('describeRun', () => {
  const run = (over: Partial<DeployRun> = {}): DeployRun => ({
    id: 1,
    name: 'Deploy',
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-09-09T10:00:00Z',
    headSha: 'abc1234',
    branch: 'main',
    ...over,
  })

  it('gives a readable label per conclusion', () => {
    expect(describeRun(run()).label).toBe('Succeeded')
    expect(describeRun(run({ conclusion: 'failure' })).label).toBe('Failed')
    expect(describeRun(run({ conclusion: 'cancelled' })).label).toBe('Cancelled')
    expect(describeRun(run({ conclusion: 'timed_out' })).label).toBe('Timed out')
    expect(describeRun(run({ status: 'in_progress', conclusion: null })).label).toBe('In progress')
  })

  it('never renders a raw enum with underscores', () => {
    expect(describeRun(run({ conclusion: 'action_required' })).label).not.toContain('_')
  })
})

describe('summarizeSteps', () => {
  const step = (name: string, status: string, detail?: string): AdminStep => ({ name, status, detail })

  it('treats an all-ok provision as published', () => {
    const s = summarizeSteps([step('repo', 'ok'), step('dns', 'ok')])
    expect(s.allOk).toBe(true)
    expect(s.summary).toBe('Published')
    expect(s.failed).toHaveLength(0)
  })

  it('flags a partial failure instead of reporting success', () => {
    // The regression this guards: /publish answers HTTP 200 with a per-step
    // report, so DNS-ok + registry-failed rendered a green "Published!".
    const s = summarizeSteps([step('dns', 'ok'), step('registry', 'fail', 'D1 write rejected')])
    expect(s.allOk).toBe(false)
    expect(s.summary).toContain('registry')
    expect(s.failed).toHaveLength(1)
    expect(s.failed[0]!.detail).toBe('D1 write rejected')
  })

  it('names every failed step when more than one fails', () => {
    const s = summarizeSteps([step('dns', 'fail'), step('registry', 'error'), step('pages', 'ok')])
    expect(s.allOk).toBe(false)
    expect(s.summary).toContain('2 steps failed')
    expect(s.summary).toContain('dns')
    expect(s.summary).toContain('registry')
  })

  it('does not treat a skipped step as a failure', () => {
    const s = summarizeSteps([step('dns', 'ok'), step('custom-domain', 'skip', 'not requested')])
    expect(s.allOk).toBe(true)
    expect(s.skipped).toHaveLength(1)
  })

  it('handles a missing step list', () => {
    expect(summarizeSteps(undefined).allOk).toBe(true)
    expect(summarizeSteps(null).allOk).toBe(true)
  })
})

describe('fetchOwnedDeployStatuses', () => {
  it('calls the authenticated backend, never GitHub directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ statuses: { demo: status() } }))
    const out = await fetchOwnedDeployStatuses('sess_token', fetchMock as unknown as typeof fetch)

    expect(out.demo?.conclusion).toBe('success')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // AC: no unauthenticated GitHub calls from creator-facing pages.
    expect(url).not.toContain('api.github.com')
    expect(url).toBe('https://api.freeappstore.online/v1/apps/deploy-status')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sess_token')
  })

  it('makes ONE request regardless of how many apps there are', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ statuses: { a: status(), b: status(), c: status() } }))
    await fetchOwnedDeployStatuses('t', fetchMock as unknown as typeof fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns an empty map without calling out when there is no token', async () => {
    const fetchMock = vi.fn()
    expect(await fetchOwnedDeployStatuses(null, fetchMock as unknown as typeof fetch)).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('degrades to an empty map on HTTP error or network failure', async () => {
    const failing = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    expect(await fetchOwnedDeployStatuses('t', failing as unknown as typeof fetch)).toEqual({})

    const throwing = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await fetchOwnedDeployStatuses('t', throwing as unknown as typeof fetch)).toEqual({})
  })
})

describe('fetchAppDeployStatus', () => {
  it('returns the app status and always an array of runs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ appId: 'demo', ...status(), runs: [] }))
    const res = await fetchAppDeployStatus('demo', 't', fetchMock as unknown as typeof fetch)

    expect(res.state).toBe('ok')
    if (res.state !== 'ok') return
    expect(res.data.appId).toBe('demo')
    expect(res.data.runs).toEqual([])
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('api.github.com')
  })

  it('tolerates a response with no runs field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ appId: 'demo', ...status() }))
    const res = await fetchAppDeployStatus('demo', 't', fetchMock as unknown as typeof fetch)
    expect(res.state).toBe('ok')
    if (res.state !== 'ok') return
    expect(res.data.runs).toEqual([])
  })

  it('reports failure rather than pretending there are no deploys', async () => {
    // The detail page has room to say "we could not load this"; rendering an
    // empty section would read as "this app never deployed".
    const cases: [number, string][] = [
      [403, "don't have access"],
      [404, 'not registered'],
      [500, 'HTTP 500'],
    ]
    for (const [code, fragment] of cases) {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: code }))
      const res = await fetchAppDeployStatus('demo', 't', fetchMock as unknown as typeof fetch)
      expect(res.state).toBe('error')
      if (res.state !== 'error') return
      expect(res.message).toContain(fragment)
    }
  })

  it('reports an error when signed out, without calling the API', async () => {
    const fetchMock = vi.fn()
    const res = await fetchAppDeployStatus('demo', null, fetchMock as unknown as typeof fetch)
    expect(res.state).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('encodes the app id into the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ appId: 'a b', runs: [] }))
    await fetchAppDeployStatus('a b', 't', fetchMock as unknown as typeof fetch)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/apps/a%20b/deploy-status')
  })
})

describe('formatting', () => {
  it('formats elapsed time in the largest sensible unit', () => {
    const now = Date.now()
    expect(formatTimeAgo(new Date(now - 5_000))).toBe('just now')
    expect(formatTimeAgo(new Date(now - 5 * 60_000))).toBe('5m ago')
    expect(formatTimeAgo(new Date(now - 3 * 3_600_000))).toBe('3h ago')
    expect(formatTimeAgo(new Date(now - 2 * 86_400_000))).toBe('2d ago')
  })

  it('does not render a future timestamp as a negative age', () => {
    expect(formatTimeAgo(new Date(Date.now() + 60_000))).toBe('just now')
  })

  it('returns an empty string for a missing or unparseable timestamp', () => {
    expect(formatTimestamp(null)).toBe('')
    expect(formatTimestamp('not-a-date')).toBe('')
  })

  it('renders a real timestamp', () => {
    expect(formatTimestamp('2026-09-09T10:00:00Z')).not.toBe('')
  })
})

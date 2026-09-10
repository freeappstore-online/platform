/**
 * Deploy status: fetching and presentation logic (#32).
 *
 * Split out of the components so the rules that decide what a creator is told
 * about a deploy — and when we admit we don't know — are testable without a
 * DOM. The components below this are thin: they render what `deriveBadge` and
 * `describeRun` return.
 *
 * Everything here goes through the authenticated backend. The console used to
 * call api.github.com directly from the browser, once per app per render, which
 * rate-limited on any real account and then failed *silently* — an exhausted
 * quota and an app that has never deployed both rendered as nothing at all.
 */

export const API_BASE = 'https://api.freeappstore.online/v1'

/** One app's latest deploy, as the backend proxy returns it. */
export interface DeployStatus {
  status: string | null
  conclusion: string | null
  at: string | null
  sha: string | null
  url?: string | null
  branch?: string | null
  neverDeployed?: boolean
}

export interface DeployRun {
  id?: number
  name: string | null
  status: string | null
  conclusion: string | null
  createdAt: string | null
  headSha: string | null
  commitMsg?: string | null
  url?: string | null
  branch?: string | null
}

export interface AppDeployStatus extends DeployStatus {
  appId: string
  runs: DeployRun[]
}

/** What the badge should say. `tone` maps to a colour; `href` is a direct link
 *  to the run when there is one worth opening. */
export type BadgeTone = 'success' | 'failure' | 'progress' | 'neutral'

export interface BadgeView {
  tone: BadgeTone
  label: string
  href: string | null
  at: string | null
}

/**
 * Decide what a single app's badge shows.
 *
 * The distinction that matters: `null`/absent status means "we could not find
 * out" and says so, while `neverDeployed` means "we asked, and CI has never
 * run here". Those used to be the same blank space.
 */
export function deriveBadge(status: DeployStatus | null | undefined): BadgeView {
  if (!status) return { tone: 'neutral', label: 'Deploy status unavailable', href: null, at: null }
  if (status.neverDeployed) {
    return { tone: 'neutral', label: 'Not deployed yet', href: null, at: null }
  }

  const at = status.at
  const href = status.url ?? null

  // An in-flight run has no conclusion yet, so check status first.
  if (status.status === 'in_progress' || status.status === 'queued' || status.status === 'waiting') {
    return { tone: 'progress', label: 'Deploying', href, at }
  }

  switch (status.conclusion) {
    case 'success':
      return { tone: 'success', label: 'Live', href, at }
    case 'failure':
    case 'timed_out':
      return { tone: 'failure', label: 'Deploy failed', href, at }
    case 'cancelled':
      return { tone: 'neutral', label: 'Deploy cancelled', href, at }
    case 'startup_failure':
      return { tone: 'failure', label: 'Deploy failed to start', href, at }
    case null:
    case undefined:
      // Completed with no conclusion, or a state we don't model. Don't claim
      // it is live — say we can't tell.
      return { tone: 'neutral', label: 'Deploy status unavailable', href, at }
    default:
      return { tone: 'neutral', label: `Deploy ${status.conclusion.replace(/_/g, ' ')}`, href, at }
  }
}

/** Human label + tone for one row in Recent Deploys. */
export function describeRun(run: DeployRun): { tone: BadgeTone; label: string } {
  if (run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting') {
    return { tone: 'progress', label: 'In progress' }
  }
  switch (run.conclusion) {
    case 'success':
      return { tone: 'success', label: 'Succeeded' }
    case 'failure':
      return { tone: 'failure', label: 'Failed' }
    case 'timed_out':
      return { tone: 'failure', label: 'Timed out' }
    case 'cancelled':
      return { tone: 'neutral', label: 'Cancelled' }
    case 'skipped':
      return { tone: 'neutral', label: 'Skipped' }
    case 'startup_failure':
      return { tone: 'failure', label: 'Failed to start' }
    default:
      return { tone: 'neutral', label: run.conclusion ? run.conclusion.replace(/_/g, ' ') : 'Unknown' }
  }
}

export function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Absolute timestamp for tooltips / detail rows, e.g. "9 Sep 2026, 14:03". */
export function formatTimestamp(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Deploy status for every app the caller owns, in one authenticated request.
 * Resolves to an empty map on any failure — the dashboard still renders, the
 * badges just say they don't know.
 */
export async function fetchOwnedDeployStatuses(
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, DeployStatus>> {
  if (!token) return {}
  try {
    const res = await fetchImpl(`${API_BASE}/apps/deploy-status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return {}
    const data = (await res.json()) as { statuses?: Record<string, DeployStatus> }
    return data.statuses ?? {}
  } catch {
    return {}
  }
}

export type AppDeployResult =
  | { state: 'ok'; data: AppDeployStatus }
  | { state: 'error'; message: string }

/**
 * One app's deploy detail. Unlike the dashboard call this reports failure,
 * because the app detail page has room to say "we couldn't load this" instead
 * of rendering an empty section that looks like "no deploys ever happened".
 */
export async function fetchAppDeployStatus(
  appId: string,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<AppDeployResult> {
  if (!token) return { state: 'error', message: 'Sign in to see deploy history.' }
  try {
    const res = await fetchImpl(`${API_BASE}/apps/${encodeURIComponent(appId)}/deploy-status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 403) return { state: 'error', message: "You don't have access to this app's deploys." }
    if (res.status === 404) return { state: 'error', message: 'This app is not registered.' }
    if (!res.ok) return { state: 'error', message: `Could not load deploys (HTTP ${res.status}).` }
    const data = (await res.json()) as AppDeployStatus
    return { state: 'ok', data: { ...data, runs: data.runs ?? [] } }
  } catch {
    return { state: 'error', message: 'Could not reach the deploy service.' }
  }
}

/** Tailwind classes per tone, shared by every deploy surface so a failure looks
 *  the same on the dashboard, the detail page and the publish result. */
export const TONE_BG: Record<BadgeTone, string> = {
  success: 'bg-[var(--success)] text-white',
  failure: 'bg-[var(--danger)] text-white',
  progress: 'bg-[var(--warning)] text-white',
  neutral: 'bg-[var(--line)] text-[var(--muted)]',
}

export const TONE_DOT: Record<BadgeTone, string> = {
  success: 'bg-[var(--success)]',
  failure: 'bg-[var(--danger)]',
  progress: 'bg-[var(--warning)]',
  neutral: 'bg-[var(--muted)]',
}

// ── Provisioning steps (#32) ────────────────────────────────────────

/** One step of the admin Worker's 5-step provision. */
export interface AdminStep {
  name: string
  status: string
  detail?: string
}

export interface StepSummary {
  failed: AdminStep[]
  skipped: AdminStep[]
  /** True only when no step reported a failure. */
  allOk: boolean
  /** Headline for the result block. */
  summary: string
}

/**
 * Decide whether a publish actually succeeded.
 *
 * The provision POST returns 200 with a per-step report, so a run where DNS
 * succeeded and the registry write failed came back as HTTP 200 and rendered a
 * green "Published!" — the creator was told they had shipped when they had
 * not. Any step with a failing status makes the whole result a partial
 * failure.
 */
export function summarizeSteps(steps: AdminStep[] | undefined | null): StepSummary {
  const list = steps ?? []
  const failed = list.filter((s) => s.status === 'fail' || s.status === 'error' || s.status === 'failed')
  const skipped = list.filter((s) => s.status === 'skip' || s.status === 'skipped')
  if (failed.length === 0) {
    return { failed, skipped, allOk: true, summary: 'Published' }
  }
  const names = failed.map((s) => s.name).join(', ')
  return {
    failed,
    skipped,
    allOk: false,
    summary:
      failed.length === 1
        ? `Partly provisioned — ${names} failed`
        : `Partly provisioned — ${failed.length} steps failed (${names})`,
  }
}

import { useId, useState } from 'react'
import type { GenerationSubmission } from '@freeappstore/sdk'
import { formatTimeAgo } from './deploy-status'
import { ArtifactPlayer } from './GenerationManager'
import type { RunRecord } from './generate'
import { useModalDialog } from './useModalDialog'

/** One of this account's submissions, with the app it went to. */
export type Mine = GenerationSubmission & { appId: string }

export type Bucket = 'accepted' | 'checking' | 'rejected' | 'not-done'
export const BUCKETS: [Bucket, string][] = [
  ['accepted', 'Accepted'], ['checking', 'Checking'], ['rejected', 'Rejected'], ['not-done', 'Not done'],
]

/** A row of Activity: a submission the server knows, or a job this browser never uploaded. */
export interface ActivityItem {
  id: string
  appId: string
  setId: string
  jobId: string
  key: string
  at: number
  bucket: Bucket
  status: string
  reason: string | null
  bytes: number | null
  /** The job's input (the server's, else this browser's, cut at its RUN_TEXT_CHARS) and its whole length. */
  text: string
  chars: number
  /** What verification measured; null until verified, and for jobs never uploaded. */
  wer: number | null
  durationMs: number | null
  /** The job's accepted artifact: this submission's own only when `bucket` is accepted. */
  artifact: GenerationSubmission['artifact']
  /** This browser's record of the job, when it ran here. */
  run: RunRecord | null
}

const SUBMISSION_STATUS: Record<GenerationSubmission['status'], [Bucket, string]> = {
  accepted: ['accepted', 'Accepted'],
  pending: ['checking', 'Checking'],
  rejected: ['rejected', 'Rejected'],
  superseded: ['rejected', 'Superseded'],
}
const RUN_STATUS: Record<RunRecord['outcome'], string> = {
  submitted: 'Uploaded', skipped: 'Skipped', stopped: 'Stopped', failed: 'Failed',
}

/**
 * The account's submissions (every device) merged with this browser's run records: an uploaded
 * run adds its generating time to its submission; the others are the jobs that were not done.
 */
export function activityItems(mine: Mine[], runs: RunRecord[]): ActivityItem[] {
  const local = new Map(runs.filter(r => r.outcome === 'submitted').map(r => [`${r.appId}/${r.jobId}`, r]))
  const known = new Set<string>()
  const items: ActivityItem[] = mine.map(s => {
    const id = `${s.appId}/${s.jobId}`
    known.add(id)
    const [bucket, status] = SUBMISSION_STATUS[s.status] ?? ['checking', s.status]
    return {
      id: s.submissionId, appId: s.appId, setId: s.setId, jobId: s.jobId, key: s.key, at: s.createdAt,
      bucket, status, bytes: s.bytes, text: s.input.text, chars: s.input.text.length,
      wer: s.wer, durationMs: s.durationMs, artifact: s.artifact, run: local.get(id) ?? null,
      reason: s.reason ?? (s.status === 'superseded' ? 'another upload for this job was accepted first' : null),
    }
  })
  for (const r of runs) {
    // An upload whose submission isn't listed (yet): it is being checked
    if (r.outcome === 'submitted' && known.has(`${r.appId}/${r.jobId}`)) continue
    items.push({
      id: `run:${r.appId}/${r.jobId}/${r.at}`, appId: r.appId, setId: r.setId, jobId: r.jobId, key: r.key, at: r.at,
      bucket: r.outcome === 'submitted' ? 'checking' : 'not-done', status: RUN_STATUS[r.outcome],
      reason: r.reason, bytes: null, text: r.text, chars: r.chars, wer: null, durationMs: null, artifact: null, run: r,
    })
  }
  return items.sort((a, b) => b.at - a.at)
}

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)
export const isToday = (ms: number) => startOfDay(ms) === startOfDay(Date.now())

function dayLabel(day: number): string {
  const today = startOfDay(Date.now())
  if (day === today) return 'Today'
  if (day === startOfDay(today - 12 * 3600_000)) return 'Yesterday'
  return new Date(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export const BUCKET_TONE: Record<Bucket, string> = {
  accepted: 'border-success text-success',
  checking: 'border-line text-ink',
  rejected: 'border-danger text-danger',
  'not-done': 'border-line text-muted',
}

const chip = (on: boolean) =>
  `px-3 py-1 rounded-full text-xs font-semibold min-h-[32px] ${on ? 'bg-ink text-paper' : 'text-muted border border-line hover:text-ink'}`
const kilobytes = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString()} KB`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const percent = (n: number) => `${(n * 100).toFixed(1)}%`

/** Activity (#820): every job this browser tried and every submission of this account, filterable. */
export function GenerateActivity({ items, appIds, onelinerOf, bucket, onBucket, app, onApp, loading, onRefresh }: {
  items: ActivityItem[]
  appIds: string[]
  onelinerOf: (appId: string) => string | null
  bucket: Bucket | ''
  onBucket: (bucket: Bucket | '') => void
  app: string
  onApp: (appId: string) => void
  loading: boolean
  onRefresh: () => void
}) {
  const [open, setOpen] = useState<ActivityItem | null>(null)
  const appSelect = useId()
  const shown = items.filter(i => (!bucket || i.bucket === bucket) && (!app || i.appId === app))
  const days: [number, ActivityItem[]][] = []
  for (const item of shown) {
    const day = startOfDay(item.at)
    if (days.at(-1)?.[0] !== day) days.push([day, []])
    days.at(-1)![1].push(item)
  }

  return (
    <div className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-muted uppercase tracking-wide">Activity</h3>
        <button onClick={onRefresh} disabled={loading} className="rounded-lg border border-line px-3 py-1 text-xs font-semibold text-ink hover:bg-panel-hover disabled:opacity-50 min-h-[44px]">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
          {([['', 'All'], ...BUCKETS] as [Bucket | '', string][]).map(([value, label]) => (
            <button key={value || 'all'} aria-pressed={bucket === value} onClick={() => onBucket(value)} className={chip(bucket === value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={appSelect} className="text-xs font-semibold text-muted">App</label>
          <select
            id={appSelect}
            value={app}
            onChange={e => onApp(e.currentTarget.value)}
            className="rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink min-h-[36px] max-w-full"
          >
            <option value="">All apps</option>
            {appIds.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
        </div>
      </div>
      <p role="status" className="sr-only">{loading ? 'Refreshing' : `${shown.length} shown`}</p>
      {shown.length === 0 && !loading && (
        <p className="text-sm text-muted">
          {items.length === 0 ? 'Nothing yet: start generating on the Status tab.' : 'Nothing matches these filters.'}
        </p>
      )}
      <div className="space-y-4">
        {days.map(([day, list]) => (
          <section key={day} aria-label={dayLabel(day)}>
            <h4 className="text-xs font-semibold text-muted mb-1">{dayLabel(day)}</h4>
            <ul className="divide-y divide-line rounded-xl border border-line bg-paper">
              {list.map(item => (
                <li key={item.id}>
                  <button
                    onClick={() => setOpen(item)}
                    aria-haspopup="dialog"
                    className="w-full text-left px-3 py-2 min-h-[44px] flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-panel-hover rounded-xl"
                  >
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${BUCKET_TONE[item.bucket]}`}>{item.status}</span>
                    <span className="text-sm text-ink font-semibold">{item.appId}</span>
                    <span className="text-sm text-ink font-mono break-all min-w-0">{item.key}</span>
                    <span className="ml-auto text-xs text-muted whitespace-nowrap">{formatTimeAgo(new Date(item.at))}</span>
                    {item.reason && <span className="basis-full text-xs text-muted break-words">{item.reason}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {open && <ActivityDetail item={open} oneliner={onelinerOf(open.appId)} onClose={() => setOpen(null)} />}
    </div>
  )
}

function ActivityDetail({ item, oneliner, onClose }: {
  item: ActivityItem
  oneliner: string | null
  onClose: () => void
}) {
  const dialogRef = useModalDialog<HTMLDivElement>(onClose)
  const titleId = useId()
  const { run, artifact } = item
  const rows: [string, string][] = [
    ['App', oneliner ? `${item.appId} · ${oneliner}` : item.appId],
    ['Job', item.key],
    ['Status', item.status],
    ...(item.reason ? [['Reason', item.reason] as [string, string]] : []),
    ['When', new Date(item.at).toLocaleString()],
    ...(item.bytes !== null ? [['Size', kilobytes(item.bytes)] as [string, string]] : []),
    ...(item.durationMs !== null ? [['Duration', seconds(item.durationMs)] as [string, string]] : []),
    ...(item.wer !== null ? [['Error rate', percent(item.wer)] as [string, string]] : []),
    ...(run ? [['Generating took', seconds(run.ms)] as [string, string]] : []),
    ['Input', `${item.chars.toLocaleString()} characters`],
  ]
  const whole = item.text.length === item.chars

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className="outline-none w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border border-line bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 id={titleId} className="text-base font-semibold text-ink break-all">{item.key}</h3>
          <button onClick={onClose} className="rounded-lg border border-line px-3 py-1 text-sm font-semibold text-ink hover:bg-panel-hover min-h-[44px]">
            Close
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted">{name}</dt>
              <dd className="text-ink break-words min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
        {artifact ? (
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              {item.bucket === 'accepted' ? 'Play' : 'Play the accepted audio (another contributor’s)'}
            </h4>
            <ArtifactPlayer
              url={artifact.url}
              metaUrl={artifact.metaUrl}
              preview={item.text}
              loadText={() => (whole ? Promise.resolve(item.text) : Promise.reject(new Error('not kept')))}
            />
          </div>
        ) : (
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Input</h4>
            <p className="text-sm text-muted break-words whitespace-pre-line max-h-48 overflow-y-auto">
              {item.text}{whole ? '' : '…'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

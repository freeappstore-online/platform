import { useEffect, useId, useState } from 'react'
import type { GenerationReport, GenerationSubmission } from '@freeappstore/sdk'
import { ProgressBar } from '@freeappstore/sdk/ui'
import { formatTimeAgo } from './deploy-status'
import { attemptRows } from './attempt'
import { ArtifactPlayer } from './GenerationManager'
import { context, keptOutput, useGenerate, type InProgress, type RunRecord } from './generate'
import { useModalDialog } from './useModalDialog'

/** One of this account's submissions, with the app it went to. */
export type Mine = GenerationSubmission & { appId: string }

export type Bucket = 'in-progress' | 'accepted' | 'checking' | 'rejected' | 'not-done'
export const BUCKETS: [Bucket, string][] = [
  ['in-progress', 'In progress'], ['accepted', 'Accepted'], ['checking', 'Checking'], ['rejected', 'Rejected'],
  ['not-done', 'Not done'],
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
  durationMs: number | null
  /** This account's Good / Not good for its upload (#831); null until it says, and for jobs never uploaded. */
  report: GenerationReport | null
  /** Whether the server has the upload, so it can take a report. */
  uploaded: boolean
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
  generating: 'In progress', submitted: 'Uploaded', skipped: 'Skipped', stopped: 'Stopped', failed: 'Failed',
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
      durationMs: s.durationMs, report: s.report ?? null, uploaded: true, artifact: s.artifact, run: local.get(id) ?? null,
      reason: s.reason ?? (s.status === 'superseded' ? 'another upload for this job was accepted first' : null),
    }
  })
  for (const r of runs) {
    // An upload whose submission isn't listed (yet): it is being checked
    if (r.outcome === 'submitted' && known.has(`${r.appId}/${r.jobId}`)) continue
    items.push({
      id: `run:${r.appId}/${r.jobId}/${r.at}`, appId: r.appId, setId: r.setId, jobId: r.jobId, key: r.key, at: r.at,
      bucket: r.outcome === 'generating' ? 'in-progress' : r.outcome === 'submitted' ? 'checking' : 'not-done',
      status: RUN_STATUS[r.outcome],
      reason: r.reason, bytes: null, text: r.text, chars: r.chars, durationMs: null, report: null, uploaded: false,
      artifact: null, run: r,
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
  'in-progress': 'border-accent text-accent',
  accepted: 'border-success text-success',
  checking: 'border-line text-ink',
  rejected: 'border-danger text-danger',
  'not-done': 'border-line text-muted',
}

const chip = (on: boolean) =>
  `px-3 py-1 rounded-full text-xs font-semibold min-h-[32px] ${on ? 'bg-ink text-paper' : 'text-muted border border-line hover:text-ink'}`
const kilobytes = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString()} KB`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const extension = (type: string) => (/mp4|m4a|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : 'bin')

function save(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
}

/**
 * Save an attempt's full record for a bug report (#843): `record.json` with every field this console
 * has (the server's submission, this browser's run and attempt record, the live job in hand) and,
 * when there is one, its audio: this browser's own, else the accepted artifact.
 */
export async function downloadRecord(item: ActivityItem, live: InProgress | null, audioUrl: string | null) {
  const name = `${item.appId}-${item.key.replace(/[^A-Za-z0-9._-]+/g, '_')}`
  const { run, text, chars, ...fields } = item
  const record = {
    exportedAt: new Date().toISOString(),
    ...fields,
    submissionId: item.uploaded ? item.id : null,
    input: { text, chars, whole: text.length === chars },
    run: run && { ...run, text: undefined },
    live: live && { ...live, audio: undefined, device: context() },
  }
  save(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }), `${name}.record.json`)
  if (!audioUrl) return
  const audio = await fetch(audioUrl).then(r => (r.ok ? r.blob() : null), () => null)
  if (audio) save(audio, `${name}.${extension(audio.type)}`)
}

/** Activity (#820): every job this browser tried and every submission of this account, filterable. */
export function GenerateActivity({ items, appIds, onelinerOf, bucket, onBucket, app, onApp, loading, onRefresh, onReport, openId, onOpen }: {
  items: ActivityItem[]
  appIds: string[]
  onelinerOf: (appId: string) => string | null
  bucket: Bucket | ''
  onBucket: (bucket: Bucket | '') => void
  app: string
  onApp: (appId: string) => void
  loading: boolean
  onRefresh: () => void
  /** Send this account's Good / Not good for an upload (#831). */
  onReport: (item: ActivityItem, good: boolean, note: string) => Promise<GenerationReport>
  /** The item whose detail is open. */
  openId: string | null
  onOpen: (id: string | null) => void
}) {
  const open = items.find(i => i.id === openId) ?? null
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
                    onClick={() => onOpen(item.id)}
                    aria-haspopup="dialog"
                    className="w-full text-left px-3 py-2 min-h-[44px] flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-panel-hover rounded-xl"
                  >
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${BUCKET_TONE[item.bucket]}`}>{item.status}</span>
                    <span className="text-sm text-ink font-semibold">{item.appId}</span>
                    <span className="text-sm text-ink font-mono break-all min-w-0">{item.key}</span>
                    {item.report && (
                      <span className={`text-xs font-semibold ${item.report.good ? 'text-success' : 'text-danger'}`}>
                        {item.report.good ? 'Good' : 'Not good'}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted whitespace-nowrap">{formatTimeAgo(new Date(item.at))}</span>
                    {item.reason && <span className="basis-full text-xs text-muted break-words">{item.reason}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {open && (
        <ActivityDetail
          item={open}
          oneliner={onelinerOf(open.appId)}
          onClose={() => onOpen(null)}
          onReport={(good, note) => onReport(open, good, note)}
        />
      )}
    </div>
  )
}

function ActivityDetail({ item, oneliner, onClose, onReport }: {
  item: ActivityItem
  oneliner: string | null
  onClose: () => void
  onReport: (good: boolean, note: string) => Promise<GenerationReport>
}) {
  const dialogRef = useModalDialog<HTMLDivElement>(onClose)
  const titleId = useId()
  const { run, artifact } = item
  // This browser's own audio of the job, while it is among the kept ones (#827)
  const [local, setLocal] = useState<{ url: string; metaUrl: string } | null>(null)
  useEffect(() => {
    if (!run) return
    let urls: { url: string; metaUrl: string } | null = null
    let live = true
    keptOutput(item.appId, item.jobId).then(kept => {
      urls = kept
      if (live) setLocal(kept)
      else if (kept) { URL.revokeObjectURL(kept.url); URL.revokeObjectURL(kept.metaUrl) }
    })
    return () => {
      live = false
      if (urls) { URL.revokeObjectURL(urls.url); URL.revokeObjectURL(urls.metaUrl) }
    }
  }, [run, item.appId, item.jobId])
  const rows: [string, string][] = [
    ['App', oneliner ? `${item.appId} · ${oneliner}` : item.appId],
    ['Job', item.key],
    ['Status', item.status],
    ...(item.reason ? [['Reason', item.reason] as [string, string]] : []),
    ['When', new Date(item.at).toLocaleString()],
    ...(item.bytes !== null ? [['Size', kilobytes(item.bytes)] as [string, string]] : []),
    ...(item.durationMs !== null ? [['Duration', seconds(item.durationMs)] as [string, string]] : []),
    ...(run ? [['Generating took', seconds(run.ms)] as [string, string]] : []),
    ['Input', `${item.chars.toLocaleString()} characters`],
  ]
  const whole = item.text.length === item.chars
  const { current } = useGenerate()
  const live = item.run?.outcome === 'generating' && current?.jobId === item.jobId && current.at === item.at ? current : null
  const audioUrl = local?.url ?? live?.audio?.url ?? artifact?.url ?? null

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
        {item.bucket === 'in-progress' && (
          live ? <LiveDetail current={live} text={item.text} /> : (
            <p className="mt-4 text-sm text-muted">Generating in another console tab or window of this browser.</p>
          )
        )}
        {run?.record && (
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">In this browser</h4>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {attemptRows(run.record).map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-muted">{name}</dt>
                  <dd className="text-ink break-words min-w-0">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {local ? (
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Play what this browser generated</h4>
            <ArtifactPlayer
              url={local.url}
              metaUrl={local.metaUrl}
              preview={item.text}
              loadText={() => (whole ? Promise.resolve(item.text) : Promise.reject(new Error('not kept')))}
            />
          </div>
        ) : artifact ? (
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
        {item.uploaded && <ReportForm report={item.report} onSend={onReport} />}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={() => downloadRecord(item, live, audioUrl)}
            className="rounded-lg border border-line px-3 py-1 text-sm font-semibold text-ink hover:bg-panel-hover min-h-[44px]"
          >
            Download record
          </button>
          <span className="text-xs text-muted">
            record.json{audioUrl ? ' and the audio' : ''}, for a bug report
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * The job this browser is generating (#838), updated live: model and voice, progress, elapsed,
 * the device, lease expiry, and the audio once encoded. A browser has no process CPU time.
 */
function LiveDetail({ current, text }: { current: InProgress; text: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const p = current.progress
  const { device, os } = context()
  const lease = current.leaseExpiresAt - now
  const rows: [string, string][] = [
    ['Model', [current.model, current.voice].filter(Boolean).join(' · ') || '—'],
    ['Progress', p ? `Sentence ${p.sentence} of ${p.sentences} · ${p.chars.toLocaleString()} of ${p.totalChars.toLocaleString()} characters · ${p.charsPerSecond.toFixed(1)} per second` : current.audio ? 'Encoded, uploading' : 'Starting…'],
    ['Elapsed', seconds(now - current.at)],
    ['CPU time', 'not measured in a browser'],
    ['Device', [device, os].filter(Boolean).join(' · ')],
    ['Lease', Number.isFinite(lease) ? (lease > 0 ? `expires in ${seconds(lease)} (${new Date(current.leaseExpiresAt).toLocaleTimeString()})` : 'expired') : '—'],
  ]
  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">In progress</h4>
      {p && <div className="mb-2"><ProgressBar value={p.chars} max={Math.max(1, p.totalChars)} label={`Sentence ${p.sentence} of ${p.sentences}`} /></div>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted">{name}</dt>
            <dd className="text-ink break-words min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      {current.audio && (
        <div className="mt-3">
          <ArtifactPlayer url={current.audio.url} metaUrl={current.audio.metaUrl} preview={text} loadText={() => Promise.reject(new Error('preview only'))} />
        </div>
      )}
    </div>
  )
}

const NOTE_CHARS = 500

/**
 * Good / Not good for this account's own upload, with an optional note (#831): people judge the
 * audio, no AI does. The app owner sees it with the upload; sending again changes it.
 */
export function ReportForm({ report, onSend }: {
  report: GenerationReport | null
  onSend: (good: boolean, note: string) => Promise<unknown>
}) {
  const [good, setGood] = useState<boolean | null>(report?.good ?? null)
  const [note, setNote] = useState(report?.note ?? '')
  const [state, setState] = useState<'idle' | 'sending' | 'error'>('idle')
  const noteId = useId()
  const send = async () => {
    if (good === null) return
    setState('sending')
    try {
      await onSend(good, note.trim())
      setState('idle')
    } catch {
      setState('error')
    }
  }
  const choice = (value: boolean, label: string, tone: string) => (
    <button
      aria-pressed={good === value}
      onClick={() => setGood(value)}
      className={`rounded-lg border px-3 py-1 text-sm font-semibold min-h-[44px] ${good === value ? tone : 'border-line text-ink hover:bg-panel-hover'}`}
    >
      {label}
    </button>
  )
  return (
    <fieldset className="mt-4">
      <legend className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Was your upload good?</legend>
      <div className="flex flex-wrap gap-2">
        {choice(true, 'Good', 'border-success bg-success-soft text-success')}
        {choice(false, 'Not good', 'border-danger bg-danger-soft text-danger')}
      </div>
      <label htmlFor={noteId} className="mt-2 block text-xs text-muted">Note (optional)</label>
      <textarea
        id={noteId}
        value={note}
        maxLength={NOTE_CHARS}
        rows={2}
        onChange={e => setNote(e.currentTarget.value)}
        placeholder="What was wrong, e.g. a skipped sentence"
        className="mt-1 w-full rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          onClick={send}
          disabled={good === null || state === 'sending'}
          className="rounded-lg bg-ink px-3 py-1 text-sm font-semibold text-paper disabled:opacity-50 min-h-[44px]"
        >
          {state === 'sending' ? 'Sending…' : report ? 'Change' : 'Send'}
        </button>
        <span role="status" className="text-xs text-muted">
          {state === 'error'
            ? "Couldn't send it. Try again."
            : report
              ? `You said ${report.good ? 'Good' : 'Not good'} ${formatTimeAgo(new Date(report.at))}. The app owner sees it.`
              : 'The app owner sees what you say. Nothing else checks the audio.'}
        </span>
      </div>
    </fieldset>
  )
}

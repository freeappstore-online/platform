import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  GenerationAttempt, GenerationJobDetail, GenerationJobSummary, GenerationReview, GenerationSetSummary,
} from '@freeappstore/sdk'
import { ConfirmDialog, ProgressBar } from '@freeappstore/sdk/ui'
import { attemptRows } from './attempt'
import { API_URL, authHeaders } from './builder/lib/api'
import { formatTimeAgo } from './deploy-status'
import { Contributors, ReviewQueue } from './GenerationReview'

/** Books-style sentence timings: [charStart, charEnd, startSec, endSec]. */
type Segment = [number, number, number, number]

type Pending =
  | { kind: 'withdraw'; jobId: string; key: string }
  | { kind: 'block'; userId: string; login: string | null }

const DOCS_URL = 'https://github.com/freeappstore-online/platform/blob/main/docs/community-generation.md'

interface Props {
  appId: string
  getToken: () => string | null
}

/** Owner view of the app's community generation: sets, jobs, artifacts, submissions (#795). */
export function GenerationManager({ appId, getToken }: Props) {
  const [sets, setSets] = useState<GenerationSetSummary[] | null>(null)
  const [error, setError] = useState('')
  const [openSet, setOpenSet] = useState<string | null>(null)
  const [panel, setPanel] = useState<'queue' | 'contributors' | null>(null)
  const base = `${API_URL}/v1/apps/${encodeURIComponent(appId)}/generation`

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch(`${base}/sets`, {
        headers: authHeaders(getToken()),
      })
      if (!res.ok) { setError(`Couldn't load generation sets (HTTP ${res.status}).`); return }
      setSets(((await res.json()) as { sets: GenerationSetSummary[] }).sets ?? [])
    } catch {
      setError("Couldn't load generation sets.")
    }
  }, [base, getToken])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-line bg-panel p-5 sm:p-6">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <h3 className="text-sm font-semibold text-muted uppercase tracking-wide">Generation sets</h3>
          {!!sets?.length && (
            <div className="flex gap-1">
              {([['queue', 'Review queue'], ['contributors', 'Contributors']] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setPanel(panel === value ? null : value)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold min-h-[32px] ${panel === value ? 'bg-ink text-paper' : 'text-muted border border-line'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {panel === 'queue' && <div className="mb-3"><ReviewQueue base={base} getToken={getToken} /></div>}
        {panel === 'contributors' && <div className="mb-3"><Contributors base={base} getToken={getToken} /></div>}
        {error && <p className="text-sm text-danger mb-3">{error}</p>}
        {!sets && !error && <p className="text-sm text-muted">Loading…</p>}
        {sets?.length === 0 && (
          <div>
            <p className="text-sm text-ink">This app has no generation sets yet.</p>
            <p className="mt-1 text-sm text-muted">
              Create a set (model, version, params) and add jobs with the API or
              <code className="mx-1 text-xs bg-paper px-1.5 py-0.5 rounded">fas.generation.createSet()</code>
              and <code className="text-xs bg-paper px-1.5 py-0.5 rounded">addJobs()</code>. Signed-in users' devices then
              generate them, and every upload is verified before it is published.
            </p>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm text-accent font-medium hover:underline">
              How community generation works &rarr;
            </a>
          </div>
        )}
        <div className="space-y-3">
          {sets?.map(set => (
            <SetCard
              key={set.id}
              appId={appId}
              set={set}
              getToken={getToken}
              open={openSet === set.id}
              onToggle={() => setOpenSet(openSet === set.id ? null : set.id)}
              onChanged={load}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SetCard({ appId, set, getToken, open, onToggle, onChanged }: {
  appId: string
  set: GenerationSetSummary
  getToken: () => string | null
  open: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const c = set.counts
  const stats: [string, number][] = [
    ['open', c.open], ['leased', c.leased], ['pending', c.pending],
    ['accepted', c.accepted], ['rejected', c.rejected], ['withdrawn', c.withdrawn],
  ]
  return (
    <div className="rounded-xl border border-line bg-paper p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink truncate">
            {set.kind.toUpperCase()} · {set.model} {set.modelVersion}
          </p>
          <p className="text-xs text-muted font-mono truncate">
            {set.id} · {set.replicas} replica{set.replicas === 1 ? '' : 's'}
            {set.requireAttestation ? ' · attestation required' : ''} · {formatTimeAgo(new Date(set.createdAt))}
          </p>
        </div>
        <button onClick={onToggle} className="text-xs font-semibold text-accent hover:underline min-h-[44px] px-2 flex-shrink-0">
          {open ? 'Hide jobs' : 'Jobs'}
        </button>
      </div>
      <div className="mt-3">
        <ProgressBar value={c.accepted} max={Math.max(1, c.jobs)} label={`${c.accepted} of ${c.jobs} jobs accepted`} />
      </div>
      <dl className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-2">
        {stats.map(([name, n]) => (
          <div key={name}>
            <dt className="text-xs text-muted">{name}</dt>
            <dd className="text-sm font-semibold text-ink">{n}</dd>
          </div>
        ))}
      </dl>
      {open && <SetJobs appId={appId} setId={set.id} getToken={getToken} onChanged={onChanged} />}
    </div>
  )
}

const STATUS_FILTERS = [['', 'All'], ['open', 'Open'], ['accepted', 'Accepted']] as const

function SetJobs({ appId, setId, getToken, onChanged }: {
  appId: string
  setId: string
  getToken: () => string | null
  onChanged: () => void
}) {
  const [status, setStatus] = useState<'' | 'open' | 'accepted'>('')
  const [jobs, setJobs] = useState<GenerationJobSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const base = `${API_URL}/v1/apps/${encodeURIComponent(appId)}/generation`

  const fetchPage = useCallback(async (after: string | null) => {
    setLoading(true)
    setError('')
    const query = new URLSearchParams()
    if (status) query.set('status', status)
    if (after) query.set('cursor', after)
    const qs = query.toString()
    try {
      const res = await fetch(`${base}/sets/${encodeURIComponent(setId)}/jobs${qs ? `?${qs}` : ''}`, {
        headers: authHeaders(getToken()),
      })
      if (!res.ok) { setError(`Couldn't load jobs (HTTP ${res.status}).`); return }
      const data = (await res.json()) as { jobs: GenerationJobSummary[]; nextCursor: string | null }
      setJobs(prev => (after ? [...prev, ...data.jobs] : data.jobs))
      setCursor(data.nextCursor)
    } catch {
      setError("Couldn't load jobs.")
    } finally {
      setLoading(false)
    }
  }, [base, setId, status, getToken])

  useEffect(() => { fetchPage(null) }, [fetchPage])

  /** The owner's review of the exact version listed (#787, #831); a 409 means it was replaced. */
  const review = async (job: GenerationJobSummary, status: GenerationReview['status'], note: string) => {
    const res = await fetch(`${base}/artifacts/${encodeURIComponent(job.id)}/review`, {
      method: 'PUT',
      headers: { ...authHeaders(getToken()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId: job.artifact!.submissionId, status, note: note || undefined }),
    })
    if (res.status === 409) fetchPage(null)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const saved = ((await res.json()) as { review: GenerationReview }).review
    setJobs(prev => prev.map(j => (j.id === job.id && j.artifact ? { ...j, artifact: { ...j.artifact, review: saved } } : j)))
  }

  /** The job's whole input: the list carries only a 200-character preview. */
  const loadText = async (jobId: string) => {
    const res = await fetch(`${base}/sets/${encodeURIComponent(setId)}/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(getToken()),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return ((await res.json()) as { job: GenerationJobDetail }).job.input.text
  }

  const confirm = async () => {
    if (!pending) return
    const action = pending
    setPending(null)
    const res = await fetch(
      action.kind === 'withdraw'
        ? `${base}/artifacts/${encodeURIComponent(action.jobId)}`
        : `${base}/contributors/${encodeURIComponent(action.userId)}/block`,
      { method: action.kind === 'withdraw' ? 'DELETE' : 'POST', headers: authHeaders(getToken()) },
    ).catch(() => null)
    if (!res?.ok) {
      setError(action.kind === 'withdraw' ? "Couldn't withdraw the artifact." : "Couldn't block the contributor.")
      return
    }
    onChanged()
    fetchPage(null)
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex gap-1 mb-3">
        {STATUS_FILTERS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setStatus(value)}
            className={`px-3 py-1 rounded-full text-xs font-semibold min-h-[32px] ${status === value ? 'bg-ink text-paper' : 'text-muted border border-line'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-danger mb-3">{error}</p>}
      {!loading && jobs.length === 0 && !error && <p className="text-sm text-muted">No jobs.</p>}
      <div className="space-y-3">
        {jobs.map(job => (
          <JobRow
            key={job.id}
            job={job}
            onAction={setPending}
            loadText={() => loadText(job.id)}
            onReview={(status, note) => review(job, status, note)}
          />
        ))}
      </div>
      {loading && <p className="mt-2 text-sm text-muted">Loading…</p>}
      {!loading && cursor && (
        <button onClick={() => fetchPage(cursor)} className="mt-3 text-xs font-semibold text-accent hover:underline min-h-[44px] px-2">
          Load more
        </button>
      )}
      <ConfirmDialog
        open={pending !== null}
        variant="danger"
        onCancel={() => setPending(null)}
        onConfirm={confirm}
        title={pending?.kind === 'block' ? 'Block contributor?' : 'Withdraw artifact?'}
        confirmLabel={pending?.kind === 'block' ? 'Block' : 'Withdraw'}
        message={
          pending?.kind === 'block'
            ? `${pending.login ?? 'This user'} can no longer contribute to this app, and everything they contributed is withdrawn.`
            : `The artifact for ${pending?.kind === 'withdraw' ? pending.key : ''} is removed and its job reopens for other contributors.`
        }
      />
    </div>
  )
}

const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`)

function JobRow({ job, onAction, loadText, onReview }: {
  job: GenerationJobSummary
  onAction: (p: Pending) => void
  loadText: () => Promise<string>
  onReview: (status: GenerationReview['status'], note: string) => Promise<void>
}) {
  const a = job.artifact
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-mono text-ink break-all">{job.key}</span>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${job.status === 'accepted' ? 'border-success text-success' : 'border-line text-muted'}`}>
          {job.status}
        </span>
        <span className="text-xs text-muted">{job.inputChars} chars</span>
      </div>
      {a ? (
        <div className="mt-2">
          <ArtifactPlayer url={a.url} preview={job.inputPreview} loadText={loadText} />
          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted">
            <span>{seconds(a.durationMs)} · {Math.round(a.bytes / 1024)} KB · by {a.contributor?.login ?? 'deleted account'} · {formatTimeAgo(new Date(a.acceptedAt))}</span>
            <button
              onClick={() => onAction({ kind: 'withdraw', jobId: job.id, key: job.key })}
              className="text-xs text-danger hover:underline min-h-[36px] px-2"
            >
              Withdraw
            </button>
          </div>
          <ReviewForm key={a.submissionId} review={a.review} onSave={onReview} />
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted break-words">{job.inputPreview}{job.inputChars > job.inputPreview.length ? '…' : ''}</p>
      )}
      {job.submissions.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="font-semibold pr-3 pb-1">Status</th>
                <th className="font-semibold pr-3 pb-1">Device says</th>
                <th className="font-semibold pr-3 pb-1">Duration</th>
                <th className="font-semibold pr-3 pb-1">Contributor</th>
                <th className="font-semibold pr-3 pb-1">Device</th>
                <th className="font-semibold pr-3 pb-1">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {job.submissions.map(s => (
                <tr key={s.id} className="border-t border-line align-top">
                  <td className="pr-3 py-1">
                    <span className={s.status === 'accepted' ? 'text-success' : s.status === 'rejected' ? 'text-danger' : 'text-ink'}>{s.status}</span>
                    {s.reason && <span className="block text-muted">{s.reason}</span>}
                  </td>
                  <td className="pr-3 py-1">
                    {s.report ? (
                      <>
                        <span className={s.report.good ? 'text-success' : 'text-danger'}>{s.report.good ? 'Good' : 'Not good'}</span>
                        {s.report.note && <span className="block text-muted break-words">{s.report.note}</span>}
                      </>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td className="pr-3 py-1 text-ink">{seconds(s.durationMs)}</td>
                  <td className="pr-3 py-1 text-ink">
                    {s.contributor ? (
                      <>
                        {s.contributor.login ?? s.contributor.id}
                        <button
                          onClick={() => onAction({ kind: 'block', userId: s.contributor!.id, login: s.contributor!.login })}
                          className="ml-2 text-danger hover:underline"
                        >
                          Block
                        </button>
                      </>
                    ) : 'deleted account'}
                  </td>
                  <td className="pr-3 py-1 text-ink">{s.deviceKind} · {s.attestation}</td>
                  <td className="pr-3 py-1 text-muted whitespace-nowrap">
                    {formatTimeAgo(new Date(s.createdAt))}
                    {s.record && <AttemptRecord record={s.record} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {job.attempts.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-muted">Attempts without an upload</p>
          <ul className="text-xs">
            {job.attempts.map(a => (
              <li key={`${a.contributor?.id}-${a.createdAt}`} className="border-t border-line py-1">
                <span className="text-ink">{a.reason}</span>
                <span className="text-muted"> · {a.contributor?.login ?? 'deleted account'} · {a.runner} · {formatTimeAgo(new Date(a.createdAt))}</span>
                <AttemptRecord record={a} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const REVIEW_LABEL: Record<GenerationReview['status'], [string, string]> = {
  reviewed: ['Reviewed', 'border-success text-success'],
  needs_changes: ['Needs changes', 'border-danger text-danger'],
}

/**
 * The owner's review of this exact version (#787, #831): Not reviewed until marked Reviewed or
 * Needs changes, with a note. A version generated again is a new one and starts unreviewed. A
 * review never publishes or withdraws anything; Withdraw does that.
 */
function ReviewForm({ review, onSave }: {
  review: GenerationReview | null
  onSave: (status: GenerationReview['status'], note: string) => Promise<void>
}) {
  const [note, setNote] = useState(review?.note ?? '')
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const save = async (status: GenerationReview['status']) => {
    setState('saving')
    try {
      await onSave(status, note.trim())
      setState('idle')
    } catch {
      setState('error')
    }
  }
  const [label, tone] = review ? REVIEW_LABEL[review.status] : ['Not reviewed', 'border-line text-muted']
  return (
    <div className="mt-2 rounded-lg border border-line p-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className={`rounded-full border px-2 py-0.5 font-semibold ${tone}`}>{label}</span>
        {review && <span className="text-muted">by {review.by} · {formatTimeAgo(new Date(review.at))}</span>}
      </div>
      {review?.note && <p className="mt-1 text-xs text-ink break-words">{review.note}</p>}
      <textarea
        aria-label="Review note (optional)"
        value={note}
        maxLength={500}
        rows={2}
        onChange={e => setNote(e.currentTarget.value)}
        placeholder="Note (optional), e.g. wrong stress on a word"
        className="mt-2 w-full rounded-lg border border-line bg-paper px-2 py-1 text-xs text-ink"
      />
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <button onClick={() => save('reviewed')} disabled={state === 'saving'} className="text-xs font-semibold text-success hover:underline disabled:opacity-50 min-h-[36px] px-2">
          Mark reviewed
        </button>
        <button onClick={() => save('needs_changes')} disabled={state === 'saving'} className="text-xs font-semibold text-danger hover:underline disabled:opacity-50 min-h-[36px] px-2">
          Needs changes
        </button>
        {state === 'error' && <span role="status" className="text-xs text-danger">Couldn't save the review.</span>}
      </div>
    </div>
  )
}

/** The device's record of one attempt (#827), folded: how it ran and ended, and what it measured. */
export function AttemptRecord({ record, label = 'Device record' }: { record: GenerationAttempt; label?: string }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-accent">{label}</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 whitespace-normal">
        {attemptRows(record).map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted">{name}</dt>
            <dd className="text-ink break-words min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

/** The artifact's meta sits beside it: same path plus `/meta`, same `?v=`. */
export const metaUrlOf = (url: string) => url.replace(/(\?|$)/, '/meta$1')

/**
 * Plays an accepted artifact and highlights the sentence being read, from the
 * meta's `segments`. On play it loads the meta and the job's whole text; until
 * the text is there (or if it can't load) it shows the 200-character preview and
 * a sentence beyond it by number.
 */
export function ArtifactPlayer({ url, metaUrl = metaUrlOf(url), preview, loadText, autoPlay = false }: {
  url: string
  /** The artifact's meta, when the server gave it (null: it has none); else beside `url`. */
  metaUrl?: string | null
  preview: string
  loadText: () => Promise<string>
  /** Start playing at once (the review queue, #842). */
  autoPlay?: boolean
}) {
  const [segments, setSegments] = useState<Segment[] | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [time, setTime] = useState(-1)
  const markRef = useRef<HTMLElement>(null)

  const load = () => {
    if (segments) return
    setSegments([])
    if (metaUrl) fetch(metaUrl)
      .then(r => (r.ok ? r.json() : null))
      .then((meta: { segments?: unknown } | null) => {
        if (Array.isArray(meta?.segments)) setSegments(meta.segments as Segment[])
      })
      .catch(() => {})
    loadText().then(setText, () => {})
  }

  const index = segments ? segments.findIndex(([, , start, end]) => time >= start && time < end) : -1
  const current = index >= 0 ? segments![index] : null
  const shown = text ?? preview
  const marked = current && current[1] <= shown.length ? current : null

  // Keep the sentence being read in view in the scrolling text
  useEffect(() => { markRef.current?.scrollIntoView({ block: 'nearest' }) }, [marked?.[0]])

  return (
    <div>
      <audio
        controls
        preload="none"
        autoPlay={autoPlay}
        src={url}
        onPlay={load}
        onTimeUpdate={e => setTime(e.currentTarget.currentTime)}
        className="w-full"
      />
      <p className={`mt-1 text-sm text-muted break-words whitespace-pre-line ${text ? 'max-h-48 overflow-y-auto' : ''}`}>
        {marked ? (
          <>
            {shown.slice(0, marked[0])}
            <mark ref={markRef} className="bg-accent/20 text-ink rounded">{shown.slice(marked[0], marked[1])}</mark>
            {shown.slice(marked[1])}
          </>
        ) : shown}
      </p>
      {current && !marked && (
        <p className="mt-1 text-xs text-accent font-semibold">Sentence {index + 1} of {segments!.length} (beyond the preview)</p>
      )}
    </div>
  )
}

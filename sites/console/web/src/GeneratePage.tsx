import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Generation, type FreeAppStore, type GenerationOpenApp } from '@freeappstore/sdk'
import {
  isKokoroDownloaded,
  KOKORO_DOWNLOAD_BYTES,
  kokoroDevice,
  kokoroEncoder,
  kokoroProblem,
  type KokoroDevice,
} from '@freeappstore/sdk/generation-kokoro'
import { ConfirmDialog, ProgressBar } from '@freeappstore/sdk/ui'
import { API_URL } from './builder/lib/api'
import {
  deleteModel,
  diagnostics,
  DIAGNOSTIC_RUNS,
  downloadModel,
  fetchOpenWork,
  modelConsented,
  optedInApps,
  reloadRuns,
  runnableSets,
  setOptIn,
  startGenerating,
  stopGenerating,
  useGenerate,
} from './generate'
import { activityItems, BUCKETS, BUCKET_TONE, GenerateActivity, isToday, type Bucket, type Mine } from './GenerateActivity'

const DOCS_URL = 'https://github.com/freeappstore-online/platform/blob/main/docs/community-generation.md'
const DEVICE_LABEL: Record<KokoroDevice, string> = { webgpu: 'WebGPU', wasm: 'WebAssembly' }
const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000).toLocaleString()} MB`

const card = 'rounded-2xl border border-line bg-panel p-5 sm:p-6'
const heading = 'text-sm font-semibold text-muted uppercase tracking-wide mb-3'
const primary = 'rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 min-h-[44px]'
const secondary = 'rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-panel-hover min-h-[44px]'

type Tab = 'status' | 'activity' | 'settings'
const TABS: [Tab, string][] = [['status', 'Status'], ['activity', 'Activity'], ['settings', 'Settings']]

/**
 * Generate (#795): any signed-in creator lends this desktop browser to the store's community
 * generation, with the SDK's shared Kokoro runner. Three tabs (#820): Status (the run, Start/Stop,
 * today's counts), Activity (this account's submissions and the jobs this browser didn't upload)
 * and Settings (apps with open work and opt-ins, the model, storage).
 */
export function GeneratePage({ fas }: { fas: FreeAppStore }) {
  const [tab, setTab] = useState<Tab>('status')
  const [encoder, setEncoder] = useState<AudioEncoderConfig | null | undefined>(undefined)
  const [device, setDevice] = useState<KokoroDevice>('wasm')
  const [downloaded, setDownloaded] = useState(false)
  const [apps, setApps] = useState<GenerationOpenApp[] | null>(null)
  const [error, setError] = useState('')
  const [optIns, setOptIns] = useState(optedInApps)
  const [mine, setMine] = useState<Mine[]>([])
  const [loadingMine, setLoadingMine] = useState(false)
  const [bucket, setBucket] = useState<Bucket | ''>('')
  const [appFilter, setAppFilter] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const run = useGenerate()

  useEffect(() => {
    reloadRuns()
    kokoroEncoder().then(setEncoder)
    kokoroDevice().then(setDevice)
    isKokoroDownloaded().then(cached => setDownloaded(cached && modelConsented()))
  }, [])

  const loadApps = useCallback(async () => {
    setError('')
    try {
      setApps(await fetchOpenWork(fas.auth.token))
    } catch {
      setError("Couldn't load the apps with open work.")
    }
  }, [fas])

  // Every app this account may have worked for: opted in, with open work, or run in this browser
  const appIds = useMemo(
    () => [...new Set([...optIns, ...(apps ?? []).map(a => a.appId), ...run.runs.map(r => r.appId)])].sort(),
    [optIns, apps, run.runs],
  )
  const appIdsKey = appIds.join(',')

  const loadMine = useCallback(async () => {
    setLoadingMine(true)
    const lists = await Promise.all(appIdsKey.split(',').filter(Boolean).map(appId =>
      new Generation(appId, API_URL, fas.auth).mySubmissions()
        .then(list => list.map(s => ({ ...s, appId })))
        .catch(() => [] as Mine[]),
    ))
    setMine(lists.flat())
    setLoadingMine(false)
  }, [fas, appIdsKey])

  useEffect(() => { loadApps() }, [loadApps])
  useEffect(() => { loadMine() }, [loadMine])
  // The run ended: the open counts changed
  useEffect(() => { if (!run.running && run.message) loadApps() }, [run.running, run.message, loadApps])

  const items = useMemo(() => activityItems(mine, run.runs), [mine, run.runs])
  const today = items.filter(i => isToday(i.at))
  const toggle = (appId: string, on: boolean) => {
    setOptIn(appId, on)
    setOptIns(optedInApps())
  }
  const openActivity = (b: Bucket, id: string | null = null) => {
    setBucket(b)
    setAppFilter('')
    setOpenId(id)
    setTab('activity')
  }

  const chosen = (apps ?? []).filter(a => optIns.includes(a.appId) && runnableSets(a).length > 0)
  const start = () => {
    if (!encoder) return
    startGenerating(fas, chosen, encoder, device, () => {
      setDownloaded(true)
      loadMine()
    }).then(() => setDownloaded(modelConsented()))
  }

  return (
    <div className="space-y-4">
      <Intro />
      <TabBar tab={tab} onTab={setTab} />
      <div role="tabpanel" id={`generate-panel-${tab}`} aria-labelledby={`generate-tab-${tab}`} className="space-y-4">
        {tab === 'status' && (
          <StatusCard
            encoder={encoder}
            downloaded={downloaded}
            appsLoaded={apps !== null}
            canStart={chosen.length > 0}
            onStart={start}
            todayCounts={BUCKETS.map(([b, label]) => [b, label, today.filter(i => i.bucket === b).length])}
            onOpenActivity={openActivity}
            onOpenCurrent={() => run.current && openActivity('in-progress', `run:${run.current.appId}/${run.current.jobId}/${run.current.at}`)}
          />
        )}
        {tab === 'activity' && (
          <GenerateActivity
            items={items}
            appIds={appIds}
            onelinerOf={appId => apps?.find(a => a.appId === appId)?.oneliner ?? null}
            bucket={bucket}
            onBucket={setBucket}
            app={appFilter}
            onApp={setAppFilter}
            loading={loadingMine}
            onRefresh={() => { loadMine(); loadApps() }}
            openId={openId}
            onOpen={setOpenId}
            onReport={async (item, good, note) => {
              const report = await new Generation(item.appId, API_URL, fas.auth).report(item.id, good, note || undefined)
              setMine(list => list.map(s => (s.submissionId === item.id ? { ...s, report } : s)))
              return report
            }}
          />
        )}
        {tab === 'settings' && (
          <>
            <div className={card}>
              <h3 className={heading}>Apps with open work</h3>
              {error && <p className="text-sm text-danger mb-3">{error}</p>}
              {!apps && !error && <p className="text-sm text-muted">Loading…</p>}
              {apps?.length === 0 && <p className="text-sm text-muted">No app has open work for you right now.</p>}
              <div className="space-y-3">
                {apps?.map(app => (
                  <AppRow key={app.appId} app={app} optedIn={optIns.includes(app.appId)} onToggle={on => toggle(app.appId, on)} />
                ))}
              </div>
            </div>
            {encoder && (
              <ModelCard encoder={encoder} device={device} downloaded={downloaded} onChanged={() => setDownloaded(modelConsented())} />
            )}
            <StorageCard downloaded={downloaded} />
            <TroubleshootingCard encoder={encoder ?? null} device={device} />
          </>
        )}
      </div>
    </div>
  )
}

/** Tabs in the console's pill style, with the ARIA tabs pattern (arrow keys, Home, End). */
function TabBar({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
  const onKeyDown = (e: KeyboardEvent) => {
    const i = TABS.findIndex(([t]) => t === tab)
    const next =
      e.key === 'ArrowRight' ? (i + 1) % TABS.length
      : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? TABS.length - 1
      : -1
    if (next < 0) return
    e.preventDefault()
    const t = TABS[next]![0]
    onTab(t)
    refs.current[t]?.focus()
  }
  return (
    <div role="tablist" aria-label="Generate" onKeyDown={onKeyDown} className="flex flex-wrap gap-1">
      {TABS.map(([t, label]) => (
        <button
          key={t}
          ref={el => { refs.current[t] = el }}
          role="tab"
          id={`generate-tab-${t}`}
          aria-selected={tab === t}
          aria-controls={`generate-panel-${t}`}
          tabIndex={tab === t ? 0 : -1}
          onClick={() => onTab(t)}
          className={`px-4 py-1 rounded-full text-sm font-semibold min-h-[44px] ${tab === t ? 'bg-ink text-paper' : 'text-muted border border-line hover:text-ink'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function StatusCard({ encoder, downloaded, appsLoaded, canStart, onStart, todayCounts, onOpenActivity, onOpenCurrent }: {
  encoder: AudioEncoderConfig | null | undefined
  downloaded: boolean
  appsLoaded: boolean
  canStart: boolean
  onStart: () => void
  todayCounts: [Bucket, string, number][]
  onOpenActivity: (bucket: Bucket) => void
  /** Open the job in hand's live detail (#838). */
  onOpenCurrent: () => void
}) {
  const { running, loading, current, submitted, skipped, message } = useGenerate()
  const p = current?.progress
  // Paused: something keeps this browser from generating
  const paused =
    encoder === null
      ? "This browser can't generate: it has no AAC audio encoder (WebCodecs), Firefox for example. Open the console in a desktop Chrome, Edge or Safari."
      : !downloaded ? "The voice model isn't downloaded yet: download it in Settings."
      : appsLoaded && !canStart ? 'No app you opted in to has work this browser can do: opt in to one in Settings.'
      : null
  const phase = running ? 'Running' : paused ? 'Paused' : 'Idle'
  const why = running ? null : paused ?? (appsLoaded ? message ?? 'Ready to generate for the apps you opted in to.' : 'Looking for open work…')

  return (
    <div className={card}>
      <h3 className={heading}>Status</h3>
      <div role="status" className="space-y-2 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${running ? 'border-success text-success' : paused ? 'border-danger text-danger' : 'border-line text-muted'}`}>
            {phase}
          </span>
          {why && <span className="text-muted">{why}</span>}
        </p>
        {running && loading !== null && (
          <ProgressBar value={Math.round(loading * 100)} max={100} label={`Loading the model: ${Math.round(loading * 100)}%`} />
        )}
        {running && !current && loading === null && <p className="text-muted">Claiming a job…</p>}
        {current && (
          <div>
            <p className="flex flex-wrap items-center gap-x-2 text-ink">
              <span className="rounded-full border border-accent px-2 py-0.5 text-xs font-semibold text-accent">In progress</span>
              <span><span className="font-semibold">{current.appId}</span> · <span className="font-mono break-all">{current.key}</span></span>
              <button onClick={onOpenCurrent} aria-haspopup="dialog" className="text-xs font-semibold text-accent hover:underline min-h-[44px] px-2">
                Details
              </button>
            </p>
            {p ? (
              <>
                <div className="mt-2"><ProgressBar value={p.chars} max={Math.max(1, p.totalChars)} label={`Sentence ${p.sentence} of ${p.sentences}`} /></div>
                <p className="mt-1 text-xs text-muted">{p.charsPerSecond.toFixed(1)} characters per second · {p.chars.toLocaleString()} of {p.totalChars.toLocaleString()}</p>
              </>
            ) : <p className="text-xs text-muted">Starting…</p>}
          </div>
        )}
        {(submitted > 0 || skipped > 0) && (
          <p className="text-xs text-muted">This session: {submitted} submitted{skipped ? `, ${skipped} skipped (this browser couldn't do them exactly)` : ''}.</p>
        )}
      </div>
      {encoder !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {running ? (
            <button onClick={stopGenerating} className={secondary}>Stop</button>
          ) : (
            <button onClick={onStart} disabled={!encoder || !downloaded || !canStart} className={primary}>Start</button>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Generating keeps going in a background tab or a minimised installed console, but only while the browser
        runs and the computer is awake (what each browser does is in How it works).
        Each job is checked by the platform before anyone hears it.
      </p>
      <h4 className="mt-4 mb-2 text-xs font-semibold text-muted uppercase tracking-wide">Today</h4>
      <div className="flex flex-wrap gap-2">
        {todayCounts.map(([b, label, n]) => (
          <button
            key={b}
            onClick={() => onOpenActivity(b)}
            aria-label={`${n} ${label.toLowerCase()} today, show in Activity`}
            className={`rounded-full border px-3 py-1 text-sm font-semibold min-h-[44px] hover:bg-panel-hover ${BUCKET_TONE[b]}`}
          >
            {label} {n}
          </button>
        ))}
      </div>
    </div>
  )
}

function ModelCard({ encoder, device, downloaded, onChanged }: {
  encoder: AudioEncoderConfig
  device: KokoroDevice
  downloaded: boolean
  onChanged: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { loading } = useGenerate()
  const size = megabytes(KOKORO_DOWNLOAD_BYTES[device])
  return (
    <div className={card}>
      <h3 className={heading}>Voice model</h3>
      <p className="text-sm text-ink">Kokoro TTS v1.0 on {DEVICE_LABEL[device]} · {size}</p>
      {downloaded ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-sm text-success font-semibold">Downloaded and kept in this browser</span>
          <button onClick={() => setConfirmDelete(true)} className="text-sm text-danger hover:underline min-h-[44px] px-2">
            Delete model
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-muted">
            Generating downloads the model ({size}) from Hugging Face once and keeps it in this browser's storage
            until you delete it.
          </p>
          {loading !== null ? (
            <div className="mt-3"><ProgressBar value={Math.round(loading * 100)} max={100} label={`Downloading the model: ${Math.round(loading * 100)}%`} /></div>
          ) : (
            <button onClick={() => downloadModel(encoder, device).then(onChanged)} className={`${primary} mt-3`}>
              Download the model ({size})
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        variant="danger"
        title="Delete the model?"
        message="Stops generating and frees the model's storage in this browser. You can download it again later."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          deleteModel().then(onChanged)
        }}
      />
    </div>
  )
}

function StorageCard({ downloaded }: { downloaded: boolean }) {
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null)
  useEffect(() => {
    navigator.storage?.estimate?.().then(setEstimate, () => setEstimate(null))
  }, [downloaded])
  return (
    <div className={card}>
      <h3 className={heading}>Storage</h3>
      {estimate?.usage !== undefined ? (
        <p className="text-sm text-ink">
          The console uses {megabytes(estimate.usage)} of this browser's storage
          {estimate.quota ? ` (of ${megabytes(estimate.quota)} available)` : ''}{downloaded ? ', most of it the voice model' : ''}.
        </p>
      ) : (
        <p className="text-sm text-muted">This browser doesn't report its storage use.</p>
      )}
    </div>
  )
}

/** Copy diagnostics (#813): what this browser can run and the latest runs' records, for a bug report. */
function TroubleshootingCard({ encoder, device }: { encoder: AudioEncoderConfig | null; device: KokoroDevice }) {
  const [copied, setCopied] = useState<'' | 'yes' | 'failed'>('')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await diagnostics(encoder, device))
      setCopied('yes')
    } catch (err) {
      console.warn('generation: diagnostics not copied', err)
      setCopied('failed')
    }
  }
  return (
    <div className={card}>
      <h3 className={heading}>Troubleshooting</h3>
      <p className="text-sm text-muted mb-3">
        Copies what this browser can run, how the last run ended and the latest {DIAGNOSTIC_RUNS} jobs' records, for a bug
        report. No text, audio or sign-in details.
      </p>
      <button type="button" className={secondary} onClick={copy}>Copy diagnostics</button>
      {copied && (
        <p role="status" className={`mt-2 text-sm ${copied === 'yes' ? 'text-muted' : 'text-danger'}`}>
          {copied === 'yes' ? 'Copied.' : "Couldn't copy: this browser refused the clipboard."}
        </p>
      )}
    </div>
  )
}

function Intro() {
  return (
    <div>
      <h2 className="display-font text-2xl font-bold text-ink">Generate</h2>
      <p className="mt-1 text-sm text-muted">
        Lend this computer to apps that pregenerate content with a local model (today: narration). Your browser
        generates a job, the platform verifies it, and everyone gets it.{' '}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">How it works</a>
      </p>
    </div>
  )
}

function AppRow({ app, optedIn, onToggle }: { app: GenerationOpenApp; optedIn: boolean; onToggle: (on: boolean) => void }) {
  const runnable = runnableSets(app).length > 0
  const open = app.sets.reduce((n, s) => n + s.open, 0)
  return (
    <div className="rounded-xl border border-line bg-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink break-words">{app.appId}</p>
          {app.oneliner && <p className="text-xs text-muted break-words">{app.oneliner}</p>}
          <p className="text-xs text-muted">{open.toLocaleString()} open job{open === 1 ? '' : 's'}</p>
        </div>
        <label className={`flex items-center gap-2 text-xs font-semibold min-h-[44px] ${runnable ? 'text-ink' : 'text-muted'}`}>
          <input type="checkbox" checked={optedIn} disabled={!runnable} onChange={e => onToggle(e.currentTarget.checked)} aria-label={`Generate for ${app.appId}`} className="size-4 accent-accent" />
          Generate for this app
        </label>
      </div>
      <ul className="mt-2 space-y-1">
        {app.sets.map(s => {
          const problem = kokoroProblem(s)
          return (
            <li key={s.setId} className="text-xs text-muted">
              <span className="text-ink">{s.kind.toUpperCase()} · {s.model} {s.modelVersion}</span> · {s.open} open
              {problem && <span> · this browser can't run it ({problem})</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

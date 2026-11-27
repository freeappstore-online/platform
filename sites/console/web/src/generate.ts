/**
 * The Generate page's runner (#795): this browser generates community jobs for the store apps the
 * creator opted in to, with the SDK's shared Kokoro runner (@freeappstore/sdk/generation-kokoro,
 * also used by Books). The state lives here, not in the page, so moving around the console does
 * not stop a run; it stops with Stop, when there is no more work, or when the window closes.
 * It keeps going in a hidden tab or a minimised installed console (#826): synthesis and encoding
 * run in the model worker, each lease is renewed on the worker's messages rather than on the
 * page's (throttled) timers, and a Web Lock keeps one run per browser profile, which Chromium also
 * counts against freezing the tab (docs/community-generation.md#running-in-the-background).
 */
import { useSyncExternalStore } from 'react'
import {
  Generation,
  type FreeAppStore,
  type GenerationAttemptRecord,
  type GenerationJob,
  type GenerationOpenApp,
} from '@freeappstore/sdk'
import {
  contributeKokoroApps,
  deleteKokoroModel,
  isKokoroDownloaded,
  KOKORO_DOWNLOAD_BYTES,
  kokoroEndReason,
  kokoroProblem,
  KokoroRunner,
  type KokoroDevice,
  type KokoroProgress,
  type KokoroResult,
} from '@freeappstore/sdk/generation-kokoro'
import { API_URL, authHeaders } from './builder/lib/api'

const OPT_IN_KEY = 'fas:generate-apps'
const MODEL_KEY = 'fas:generate-model'
const RUNS_KEY = 'fas:generate-runs'
/** Run records kept, newest first, and the input text each keeps (for the Activity detail). */
const MAX_RUNS = 200
const RUN_TEXT_CHARS = 4000

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {}
}

/** The apps this browser generates for (per-app opt-in). */
export function optedInApps(): string[] {
  try { return JSON.parse(read(OPT_IN_KEY) ?? '[]') as string[] } catch { return [] }
}
export function setOptIn(appId: string, on: boolean) {
  const apps = optedInApps().filter(a => a !== appId)
  write(OPT_IN_KEY, JSON.stringify(on ? [...apps, appId] : apps))
}

/** Whether the creator agreed to the model download and it completed in this browser. */
export const modelConsented = () => read(MODEL_KEY) === '1'

/** Apps with open work for this creator (a console session sees every store app). */
export async function fetchOpenWork(token: string | null): Promise<GenerationOpenApp[]> {
  const res = await fetch(`${API_URL}/v1/generation/open`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return ((await res.json()) as { apps: GenerationOpenApp[] }).apps
}

/** The app's sets this runner can generate exactly (Kokoro v1.0, audio/mp4, voice/speed). */
export const runnableSets = (app: GenerationOpenApp) => app.sets.filter(s => !kokoroProblem(s))

/**
 * A job this browser tried (#820): kept in localStorage so Activity can list the jobs that never
 * reached the server (skipped, stopped, failed) and show an uploaded job's text and timing.
 */
export interface RunRecord {
  appId: string
  setId: string
  jobId: string
  key: string
  /** When the job was claimed (ms epoch). */
  at: number
  /** `generating` from the claim until it ends (#838); one left by a closed page ends `stopped`. */
  outcome: 'generating' | 'submitted' | 'skipped' | 'stopped' | 'failed'
  reason: string | null
  /** Wall time from claim to upload or give-up. */
  ms: number
  /** The input, cut at RUN_TEXT_CHARS; `chars` is its whole length. */
  text: string
  chars: number
  /** What this browser measured (#827), as sent to the server; absent on records from before. */
  record?: GenerationAttemptRecord
}

function loadRuns(): RunRecord[] {
  try {
    const runs = JSON.parse(read(RUNS_KEY) ?? '[]')
    return Array.isArray(runs) ? (runs as RunRecord[]) : []
  } catch { return [] }
}

/** The job in hand (#838), for its live detail. */
export interface InProgress {
  appId: string
  setId: string
  jobId: string
  key: string
  /** When it was claimed. */
  at: number
  model: string
  voice: string | null
  /** Moves on as the lease is extended. */
  leaseExpiresAt: number
  progress: KokoroProgress | null
  /** The encoded audio and its sentence timings as object URLs, once ready. */
  audio: { url: string; metaUrl: string } | null
}

export interface GenerateState {
  running: boolean
  /** Model download progress (0-1) while loading, else null. */
  loading: number | null
  /** The job being generated. */
  current: InProgress | null
  submitted: number
  skipped: number
  /** How the last run ended, or why it failed. */
  message: string | null
  /** This browser's run records, newest first. */
  runs: RunRecord[]
}

let state: GenerateState = {
  running: false, loading: null, current: null, submitted: 0, skipped: 0, message: null, runs: loadRuns(),
}
const listeners = new Set<() => void>()
function set(next: Partial<GenerateState>) {
  const audio = state.current?.audio
  if (audio && 'current' in next && next.current?.audio !== audio) {
    URL.revokeObjectURL(audio.url)
    URL.revokeObjectURL(audio.metaUrl)
  }
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

const sameRun = (a: RunRecord, b: RunRecord) => a.appId === b.appId && a.jobId === b.jobId && a.at === b.at

/** Keep `run` first, in place of its own earlier state. */
function saveRun(run: RunRecord) {
  const runs = [run, ...state.runs.filter(r => !sameRun(r, run))].slice(0, MAX_RUNS)
  write(RUNS_KEY, JSON.stringify(runs))
  set({ runs })
}

/**
 * Re-read the run records (another console tab may have added some). A job still `generating`
 * while no tab of this browser runs (none holds the lock) was cut off by a closed page (#838).
 */
export async function reloadRuns() {
  if (state.running) return
  const held = await navigator.locks?.query?.().then(q => q.held?.some(l => l.name === LOCK), () => false)
  if (state.running) return
  const runs = loadRuns()
  const cut = held ? [] : runs.filter(r => r.outcome === 'generating')
  for (const r of cut) Object.assign(r, { outcome: 'stopped', reason: 'interrupted: the console closed before it finished' })
  if (cut.length) write(RUNS_KEY, JSON.stringify(runs))
  set({ runs })
}

export function useGenerate(): GenerateState {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => state,
    () => state,
  )
}

let runner: KokoroRunner | null = null
let runnerKey = ''
function getRunner(encoder: AudioEncoderConfig, device: KokoroDevice): KokoroRunner {
  const key = JSON.stringify([encoder, device])
  if (!runner || key !== runnerKey) {
    runner?.dispose()
    runner = new KokoroRunner({
      createWorker: () => new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' }),
      encoder,
      device,
    })
    runnerKey = key
  }
  return runner
}

/** The job in hand: when it was claimed and what has been measured so far (#827). */
interface Pending {
  appId: string
  generation: Generation
  job: GenerationJob
  at: number
  start: Power
  background: boolean
  result: KokoroResult | null
  /** When the audio was ready, so the rest until `submitted` is the upload. */
  generatedAt: number | null
}

/** Battery where the browser tells it (Chromium's Battery Status API). */
interface Power { battery?: number; charging?: boolean }
async function power(): Promise<Power> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> }
  const b = await nav.getBattery?.().catch(() => null)
  return b ? { battery: Math.round(b.level * 100), charging: b.charging } : {}
}

/** The browser and OS this runs in, and the network type where the browser tells it. */
export function context(): Pick<GenerationAttemptRecord, 'os' | 'device' | 'network'> {
  const nav = navigator as Navigator & {
    userAgentData?: { platform: string; brands: { brand: string; version: string }[] }
    connection?: { effectiveType?: string; type?: string }
  }
  const brand = nav.userAgentData?.brands.find(b => !/not.?a.?brand|chromium/i.test(b.brand))
  const network = nav.connection?.type ?? nav.connection?.effectiveType
  return {
    os: (nav.userAgentData?.platform || navigator.platform || '').slice(0, 300) || undefined,
    device: (brand ? `${brand.brand} ${brand.version}` : navigator.userAgent).slice(0, 300),
    ...(network && { network }),
  }
}

/**
 * What this browser generates with (#813), taken at the start of each run and for Copy
 * diagnostics: the browser, CPU cores and memory, the accelerator asked for and the one the model
 * really runs on (WebGPU falls back to WebAssembly), the AAC encoder, whether the model is
 * downloaded, storage, battery and network. Nothing about the account.
 */
export async function capabilityReport(encoder: AudioEncoderConfig | null, device: KokoroDevice) {
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: unknown }
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined)
  return {
    runner: 'browser',
    ...context(),
    cores: nav.hardwareConcurrency ?? null,
    memoryGb: nav.deviceMemory ?? null,
    webgpu: 'gpu' in nav,
    accelerator: device,
    acceleratorInUse: runner?.device ?? null,
    aacEncoder: encoder && { sampleRate: encoder.sampleRate, bitrate: encoder.bitrate ?? null },
    model: 'kokoro v1.0',
    modelDownloaded: modelConsented() && (await isKokoroDownloaded().catch(() => false)),
    storageUsedMb: estimate?.usage !== undefined ? Math.round(estimate.usage / 1e6) : null,
    storageQuotaMb: estimate?.quota !== undefined ? Math.round(estimate.quota / 1e6) : null,
    ...(await power()),
  }
}

/** The capability report taken when the last run started (#813), or null. */
let startCapabilities: Awaited<ReturnType<typeof capabilityReport>> | null = null

/** How many of the latest runs Copy diagnostics includes. */
export const DIAGNOSTIC_RUNS = 50

/**
 * Copy diagnostics (#813), for a bug report: the capability report now and at the last run's
 * start, how the last run ended, and the latest runs with their reasons and attempt records.
 * Never the input text, the audio or any credential.
 */
export async function diagnostics(encoder: AudioEncoderConfig | null, device: KokoroDevice): Promise<string> {
  const runs = state.runs.slice(0, DIAGNOSTIC_RUNS).map(({ text: _text, ...run }) => ({ ...run, at: new Date(run.at).toISOString() }))
  return JSON.stringify({
    at: new Date().toISOString(),
    capabilities: await capabilityReport(encoder, device),
    capabilitiesAtLastStart: startCapabilities,
    lastMessage: state.message,
    runs,
  }, null, 2)
}

const OUTPUTS = 'fas-generate-outputs'
/** Generated audio (with its segments) this browser keeps for Activity, newest. */
const KEEP_OUTPUTS = 20
const outputUrl = (appId: string, jobId: string) => `https://outputs.invalid/${appId}/${jobId}`

/** Keep the audio and segments for Activity's playback; the oldest beyond KEEP_OUTPUTS go. */
async function keepOutput(appId: string, jobId: string, result: KokoroResult) {
  try {
    const cache = await caches.open(OUTPUTS)
    await cache.put(outputUrl(appId, jobId), new Response(result.file, { headers: { 'Content-Type': result.file.type } }))
    await cache.put(`${outputUrl(appId, jobId)}/meta`, new Response(JSON.stringify(result.meta)))
    const keys = await cache.keys()
    await Promise.all(keys.slice(0, Math.max(0, keys.length - 2 * KEEP_OUTPUTS)).map(k => cache.delete(k)))
  } catch (e) {
    console.warn('generation: output not kept', e)
  }
}

/** A kept output as object URLs for `ArtifactPlayer` (revoke them when done), or null once pruned. */
export async function keptOutput(appId: string, jobId: string): Promise<{ url: string; metaUrl: string } | null> {
  try {
    const cache = await caches.open(OUTPUTS)
    const [audio, meta] = await Promise.all([cache.match(outputUrl(appId, jobId)), cache.match(`${outputUrl(appId, jobId)}/meta`)])
    if (!audio || !meta) return null
    return { url: URL.createObjectURL(await audio.blob()), metaUrl: URL.createObjectURL(await meta.blob()) }
  } catch { return null }
}

function record(p: Pending, outcome: RunRecord['outcome'], reason: string | null, err?: unknown) {
  const { job, at, result } = p
  const now = Date.now()
  const segments = result?.meta.segments
  const durationMs = segments?.length ? Math.round(segments.at(-1)![3] * 1000) : undefined
  const attempt: GenerationAttemptRecord = {
    runner: 'browser',
    reason: kokoroEndReason(outcome === 'generating' ? 'stopped' : outcome, reason, err),
    ...(outcome !== 'submitted' && reason && { error: reason.slice(0, 300) }),
    ...context(),
    background: p.background || document.visibilityState === 'hidden',
    ...(p.start.battery !== undefined && { batteryStart: p.start.battery, chargingStart: p.start.charging }),
    startedAt: at,
    wallMs: now - at,
    ...result?.timing,
    ...(outcome === 'submitted' && p.generatedAt && { uploadMs: now - p.generatedAt }),
    ...(result && { bytes: result.file.size }),
    ...(durationMs && { durationMs }),
    ...(durationMs && result?.timing && { rtf: Math.round((result.timing.synthMs / durationMs) * 1000) / 1000 }),
  }
  const run: RunRecord = { ...runOf(p), outcome, reason, ms: now - at, record: attempt }
  // Battery at the end, then the server's copy: numbers only, best effort (#827)
  void power().then(end => {
    if (end.battery !== undefined) Object.assign(attempt, { batteryEnd: end.battery, chargingEnd: end.charging })
    return p.generation.recordAttempts([{ jobId: job.id, ...attempt }])
  }).catch(e => console.warn('generation: attempt record not sent', e))
  saveRun(run)
}

/** The job in hand's run record, `generating` until it ends. */
const runOf = ({ appId, job, at }: Pending): RunRecord => ({
  appId, setId: job.setId, jobId: job.id, key: job.key, at, outcome: 'generating', reason: null, ms: 0,
  text: job.input.text.slice(0, RUN_TEXT_CHARS), chars: job.input.text.length,
})

const inProgress = ({ appId, job, at }: Pending): InProgress => ({
  appId, setId: job.setId, jobId: job.id, key: job.key, at,
  model: [job.model, job.modelVersion].filter(Boolean).join(' '),
  voice: typeof job.params?.voice === 'string' ? job.params.voice : null,
  leaseExpiresAt: job.leaseExpiresAt, progress: null, audio: null,
})

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Download (unless cached) and load the model, after the creator agreed to its size. */
export async function downloadModel(encoder: AudioEncoderConfig, device: KokoroDevice) {
  set({ loading: 0, message: null })
  try {
    // Nothing is fetched when the browser says its storage for the console can't hold the model (#792).
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined)
    const room = estimate?.quota !== undefined && estimate.usage !== undefined ? estimate.quota - estimate.usage : null
    const need = KOKORO_DOWNLOAD_BYTES[device]
    if (room !== null && room < need) {
      const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`
      throw new Error(`this browser has ${mb(room)} of storage left for the console and the model needs ${mb(need)}`)
    }
    await getRunner(encoder, device).load(progress => set({ loading: progress }))
    write(MODEL_KEY, '1')
  } catch (err) {
    set({ message: `The model didn't download: ${errorText(err)}` })
  } finally {
    set({ loading: null })
  }
}

/** Free the model's memory and storage. */
export async function deleteModel() {
  stopGenerating()
  runner?.dispose()
  runner = null
  write(MODEL_KEY, null)
  await deleteKokoroModel()
}

let controller: AbortController | null = null
/** One run per browser profile, whichever console tab or window holds it. */
const LOCK = 'fas:generate'

/** The screen wake lock, taken again whenever the page is shown: the browser drops it on hide. */
function keepAwake(): () => void {
  let lock: WakeLockSentinel | null = null
  const take = () => {
    if (document.visibilityState !== 'visible' || (lock && !lock.released)) return
    navigator.wakeLock?.request('screen').then(l => { lock = l }, () => {})
  }
  take()
  document.addEventListener('visibilitychange', take)
  return () => {
    document.removeEventListener('visibilitychange', take)
    lock?.release().catch(() => {})
  }
}

/**
 * Generate for the opted-in apps' runnable sets, one job from each app in turn (as the phones
 * do), until no work or Stop. Holds the `fas:generate` Web Lock while it runs; when another tab
 * or window of this browser holds it, says so and does nothing.
 */
export async function startGenerating(
  fas: FreeAppStore,
  apps: GenerationOpenApp[],
  encoder: AudioEncoderConfig,
  device: KokoroDevice,
  onSubmitted: (appId: string) => void,
) {
  if (state.running) return
  if (!navigator.locks) return run(fas, apps, encoder, device, onSubmitted)
  await navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
    if (lock) await run(fas, apps, encoder, device, onSubmitted)
    else set({ message: 'Already generating in another console tab or window of this browser.' })
  })
}

async function run(
  fas: FreeAppStore,
  apps: GenerationOpenApp[],
  encoder: AudioEncoderConfig,
  device: KokoroDevice,
  onSubmitted: (appId: string) => void,
) {
  if (state.running) return
  controller = new AbortController()
  const { signal } = controller
  set({ running: true, current: null, message: null })
  // A screen that turns off would put the computer to sleep
  const release = keepAwake()
  const work = getRunner(encoder, device)
  startCapabilities = await capabilityReport(encoder, device)
  console.info('generation: capabilities', startCapabilities)
  // The job in hand, recorded when it ends however it ends
  let pending: Pending | null = null
  const finish = (outcome: RunRecord['outcome'], reason: string | null, err?: unknown) => {
    if (pending) record(pending, outcome, reason, err)
    pending = null
  }
  const onHidden = () => { if (pending && document.visibilityState === 'hidden') pending.background = true }
  document.addEventListener('visibilitychange', onHidden)
  let battery: Power = await power()
  const claimed = (appId: string, job: GenerationJob): Pending => {
    const p: Pending = {
      appId, generation: kokoroApps.find(a => a.appId === appId)!.generation, job, at: Date.now(), start: battery,
      background: document.visibilityState === 'hidden', result: null, generatedAt: null,
    }
    // For the next claim: read now, so a claim's battery is never waited for
    void power().then(p => { battery = p })
    // On the record from the claim (#838), so a page closed mid-job leaves it interrupted
    saveRun(runOf(p))
    return p
  }
  const kokoroApps = apps.map(app => ({
    appId: app.appId,
    generation: new Generation(app.appId, API_URL, fas.auth),
    setIds: runnableSets(app).map(s => s.setId),
  }))
  try {
    await contributeKokoroApps({
      runner: work,
      signal,
      // An app turned off in Settings mid-run leaves at its next turn
      apps: () => kokoroApps.filter(a => optedInApps().includes(a.appId)),
      onEvent: (e, appId) => {
        if (e.type === 'loading') set({ loading: e.progress })
        else if (e.type === 'claimed') {
          // A job still in hand at the next claim was abandoned when its lease ran out
          finish('stopped', 'the lease ran out before it finished')
          pending = claimed(appId, e.job)
          set({ loading: null, current: inProgress(pending) })
        } else if (e.type === 'progress') {
          if (state.current?.jobId === e.job.id)
            set({ current: { ...state.current, progress: e.progress, leaseExpiresAt: e.job.leaseExpiresAt } })
        } else if (e.type === 'generated') {
          const p = pending
          if (p?.job.id !== e.job.id) return
          p.result = e.result
          p.generatedAt = Date.now()
          void keepOutput(appId, e.job.id, e.result)
          if (state.current?.jobId === e.job.id) {
            const audio = {
              url: URL.createObjectURL(e.result.file),
              metaUrl: URL.createObjectURL(new Blob([JSON.stringify(e.result.meta)], { type: 'application/json' })),
            }
            set({ current: { ...state.current, audio, leaseExpiresAt: e.job.leaseExpiresAt } })
          }
        }
        else if (e.type === 'submitted') {
          finish('submitted', null)
          set({ submitted: state.submitted + 1, current: null })
          onSubmitted(appId)
        } else {
          if (pending?.job.id !== e.job.id) pending = claimed(appId, e.job)
          finish(e.type, e.reason, e.type === 'failed' ? e.error : undefined)
          set(e.type === 'skipped' ? { skipped: state.skipped + 1, current: null } : { current: null })
        }
      },
    })
    // A job still in hand when the run ends by itself ran out of lease (no event says so)
    finish('stopped', signal.aborted ? 'stopped before it finished' : 'the lease ran out before it finished')
    set({ message: signal.aborted ? 'Stopped.' : 'No more work for now.' })
  } catch (err) {
    if (signal.aborted) finish('stopped', 'stopped before it finished')
    else finish('failed', errorText(err), err)
    set({ message: signal.aborted ? 'Stopped.' : `Stopped on an error: ${errorText(err)}` })
  } finally {
    document.removeEventListener('visibilitychange', onHidden)
    release()
    controller = null
    set({ running: false, loading: null, current: null })
  }
}

export function stopGenerating() {
  controller?.abort(new DOMException('Stopped', 'AbortError'))
}

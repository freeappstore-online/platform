// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GenerationError, type FreeAppStore, type GenerationOpenApp } from '@freeappstore/sdk'
import * as kokoro from '@freeappstore/sdk/generation-kokoro'
import { GeneratePage } from './GeneratePage'

const load = vi.fn(async (onLoading?: (p: number) => void) => { onLoading?.(0.5) })
vi.mock('@freeappstore/sdk/generation-kokoro', async (actual) => ({
  ...(await actual<typeof import('@freeappstore/sdk/generation-kokoro')>()),
  kokoroEncoder: vi.fn(),
  kokoroDevice: vi.fn(async () => 'webgpu'),
  isKokoroDownloaded: vi.fn(async () => false),
  deleteKokoroModel: vi.fn(async () => {}),
  contributeKokoroApps: vi.fn(),
  KokoroRunner: class { load = load; dispose() {} },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const fas = { auth: { token: 'tok', handleUnauthorized: vi.fn() } } as unknown as FreeAppStore
const encoder = { codec: 'mp4a.40.2', sampleRate: 24_000, numberOfChannels: 1, bitrate: 40_000 }
const api = 'https://api.freeappstore.online/v1'

const books: GenerationOpenApp = {
  appId: 'books', oneliner: 'Free books',
  sets: [{ setId: 's1', kind: 'tts', language: 'en-US', model: 'kokoro', modelVersion: 'v1.0', params: { voice: 'af_heart' }, formats: ['audio/mp4'], maxBytes: 25_000_000, open: 12 }],
}
const other: GenerationOpenApp = {
  appId: 'radio', oneliner: null,
  sets: [{ setId: 's2', kind: 'tts', language: null, model: 'piper', modelVersion: '1', params: {}, formats: ['audio/ogg'], maxBytes: 1, open: 3 }],
}
const submission = {
  submissionId: 'x1', jobId: 'j1', setId: 's1', key: 'alice/0', status: 'rejected',
  reason: 'audio is too long for the text',
  bytes: 4096, contentType: 'audio/mp4', createdAt: Date.now(), decidedAt: Date.now(),
  durationMs: 3000, report: null, input: { text: 'Call me Ishmael.' }, artifact: null,
}
let submissions: unknown[]

beforeEach(() => {
  localStorage.clear()
  submissions = [submission]
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.mocked(kokoro.kokoroEncoder).mockResolvedValue(encoder)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === `${api}/generation/open`) return new Response(JSON.stringify({ apps: [books, other] }))
    if (url === `${api}/apps/books/generation/submissions`) return new Response(JSON.stringify({ submissions }))
    if (url === `${api}/apps/books/generation/submissions/x1/report`) {
      return new Response(JSON.stringify({ report: { good: false, note: 'mumbles', at: Date.now() } }))
    }
    if (url === `${api}/apps/books/generation/artifacts/j2/meta?v=1`) {
      return new Response(JSON.stringify({ segments: [[0, 12, 0, 1], [13, 28, 1, 2]] }))
    }
    return new Response('not found', { status: 404 })
  }))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))
const render = async () => {
  await act(async () => root.render(<GeneratePage fas={fas} />))
  await flush()
}
const click = async (el: HTMLElement) => {
  await act(async () => el.click())
  await flush()
}
const tab = (name: string) =>
  click([...document.querySelectorAll<HTMLElement>('[role=tab]')].find((t) => t.textContent === name)!)

it('explains and hides the runner where WebCodecs AAC is missing', async () => {
  vi.mocked(kokoro.kokoroEncoder).mockResolvedValue(null)
  await render()
  expect(container.textContent).toContain('Paused')
  expect(container.textContent).toContain("This browser can't generate")
  expect(container.textContent).toContain('AAC')
  expect(button('Start')).toBeUndefined()
  await tab('Settings')
  expect(button('Download')).toBeUndefined()
})

it('splits the page into Status, Activity and Settings tabs, with arrow keys between them', async () => {
  await render()
  const tabs = [...container.querySelectorAll<HTMLElement>('[role=tab]')]
  expect(tabs.map((t) => t.textContent)).toEqual(['Status', 'Activity', 'Settings'])
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
  expect(container.querySelector('[role=tabpanel]')!.getAttribute('aria-labelledby')).toBe(tabs[0]!.id)
  await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  expect(tabs[2]!.getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(tabs[2])
  expect(container.textContent).toContain('Apps with open work')
})

it('downloads nothing when the browser has no room for the model (#792)', async () => {
  Object.defineProperty(navigator, 'storage', {
    configurable: true, value: { estimate: async () => ({ quota: 400e6, usage: 300e6 }) },
  })
  try {
    await render()
    await tab('Settings')
    await click(button('Download the model (326 MB)')!)
    expect(load).not.toHaveBeenCalled()
    expect(container.textContent).toContain("The model didn't download: this browser has 100 MB of storage left for the console and the model needs 326 MB")
  } finally {
    Reflect.deleteProperty(navigator, 'storage')
  }
})

it('lists apps with open work, opts in per app, and downloads the model only after the creator agrees', async () => {
  await render()
  expect(container.textContent).toContain("The voice model isn't downloaded yet")
  expect(button('Start')!.disabled).toBe(true)

  await tab('Settings')
  expect(container.textContent).toContain('books')
  expect(container.textContent).toContain('12 open jobs')
  expect(container.textContent).toContain("can't run it (model piper 1)")
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
  expect(boxes[0]!.getAttribute('aria-label')).toBe('Generate for books')
  expect(boxes[1]!.disabled).toBe(true)

  // Nothing is downloaded until the creator asks, with the size shown
  expect(load).not.toHaveBeenCalled()
  expect(button('Download the model (326 MB)')).toBeDefined()

  await click(boxes[0]!)
  expect(JSON.parse(localStorage.getItem('fas:generate-apps')!)).toEqual(['books'])

  await click(button('Download the model')!)
  expect(load).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Downloaded and kept in this browser')

  await tab('Status')
  expect(container.textContent).toContain('keeps going in a background tab')
  expect(container.textContent).toContain('Idle')
  expect(button('Start')!.disabled).toBe(false)
})

it('generates for the opted-in apps’ runnable sets, shows progress, stops, and records the unfinished job', async () => {
  localStorage.setItem('fas:generate-apps', JSON.stringify(['books', 'radio']))
  localStorage.setItem('fas:generate-model', '1')
  vi.mocked(kokoro.isKokoroDownloaded).mockResolvedValue(true)
  let finish = () => {}
  vi.mocked(kokoro.contributeKokoroApps).mockImplementation(async (opts) => {
    const job = { id: 'j3', setId: 's1', key: 'alice/3', input: { text: 'Once upon a time.' } } as never
    opts.onEvent?.({ type: 'claimed', job }, 'books')
    opts.onEvent?.({ type: 'progress', job, progress: { sentence: 4, sentences: 10, chars: 400, totalChars: 1000, charsPerSecond: 21.5 } }, 'books')
    await new Promise<void>((resolve) => { finish = resolve; opts.signal.addEventListener('abort', () => resolve()) })
    return { submitted: 0, stopped: 'aborted' }
  })
  await render()
  await click(button('Start')!)
  expect(kokoro.contributeKokoroApps).toHaveBeenCalledOnce()
  // Only runnable sets of opted-in apps; radio (piper) has none
  const opts = vi.mocked(kokoro.contributeKokoroApps).mock.calls[0]![0]
  expect(opts.apps().map((a) => [a.appId, a.setIds])).toEqual([['books', ['s1']]])
  // Turned off mid-run: left out from its next turn
  localStorage.setItem('fas:generate-apps', JSON.stringify([]))
  expect(opts.apps()).toEqual([])
  expect(container.textContent).toContain('Running')
  expect(container.textContent).toContain('alice/3')
  expect(container.textContent).toContain('Sentence 4 of 10')
  expect(container.textContent).toContain('21.5 characters per second')

  await click(button('Stop')!)
  expect(container.textContent).toContain('Stopped.')
  expect(button('Start')).toBeDefined()
  expect(button('Not done 1')).toBeDefined()
  const runs = JSON.parse(localStorage.getItem('fas:generate-runs')!)
  expect(runs).toMatchObject([{ appId: 'books', jobId: 'j3', key: 'alice/3', outcome: 'stopped', text: 'Once upon a time.' }])
  finish()
})

it('records what each attempt measured, sends it, and shows it in Activity (#827)', async () => {
  localStorage.setItem('fas:generate-apps', JSON.stringify(['books']))
  localStorage.setItem('fas:generate-model', '1')
  vi.mocked(kokoro.isKokoroDownloaded).mockResolvedValue(true)
  submissions = []
  vi.mocked(kokoro.contributeKokoroApps).mockImplementation(async (opts) => {
    const job = { id: 'j4', setId: 's1', key: 'alice/4', input: { text: 'Hello there.' } } as never
    opts.onEvent?.({ type: 'claimed', job }, 'books')
    const file = new Blob([new Uint8Array(2048)], { type: 'audio/mp4' })
    const result = { file, meta: { segments: [[0, 12, 0, 2]] as [number, number, number, number][] }, timing: { loadMs: 800, synthMs: 1000, encodeMs: 30 } }
    opts.onEvent?.({ type: 'generated', job, result }, 'books')
    opts.onEvent?.({ type: 'submitted', job, submitted: 1 }, 'books')
    return { submitted: 1, stopped: 'no-work' }
  })
  await render()
  await click(button('Start')!)
  const [run] = JSON.parse(localStorage.getItem('fas:generate-runs')!)
  expect(run.record).toMatchObject({
    runner: 'browser', reason: 'submitted', loadMs: 800, synthMs: 1000, encodeMs: 30, bytes: 2048, durationMs: 2000, rtf: 0.5,
    background: false, wallMs: expect.any(Number), uploadMs: expect.any(Number),
  })
  const sent = vi.mocked(fetch).mock.calls.find(([url]) => url === `${api}/apps/books/generation/events`)
  expect(JSON.parse(sent![1]!.body as string).events).toMatchObject([{ jobId: 'j4', runner: 'browser', reason: 'submitted', synthMs: 1000 }])

  await tab('Activity')
  await click(button('Uploaded')!)
  expect(document.body.textContent).toContain('In this browser')
  expect(document.body.textContent).toContain('load 800 ms · synthesis 1.0 s · encode 30 ms')
  expect(document.body.textContent).toContain('0.50× real time')
})

it("records the run's last job as lease_cap when its lease ran out, not as a stop", async () => {
  localStorage.setItem('fas:generate-apps', JSON.stringify(['books']))
  localStorage.setItem('fas:generate-model', '1')
  vi.mocked(kokoro.isKokoroDownloaded).mockResolvedValue(true)
  submissions = []
  vi.mocked(kokoro.contributeKokoroApps).mockImplementation(async (opts) => {
    // The lease ran out: the runner emits nothing more and the app leaves the run
    opts.onEvent?.({ type: 'claimed', job: { id: 'j5', setId: 's1', key: 'alice/5', input: { text: 'Hi.' } } as never }, 'books')
    return { submitted: 0, stopped: 'no-work' }
  })
  await render()
  await click(button('Start')!)
  const [run] = JSON.parse(localStorage.getItem('fas:generate-runs')!)
  expect(run).toMatchObject({ jobId: 'j5', outcome: 'stopped', record: { reason: 'lease_cap' } })
})

it('records a model failure as model_error and an upload refused as lease_403 (#813)', async () => {
  localStorage.setItem('fas:generate-apps', JSON.stringify(['books']))
  localStorage.setItem('fas:generate-model', '1')
  vi.mocked(kokoro.isKokoroDownloaded).mockResolvedValue(true)
  vi.mocked(kokoro.contributeKokoroApps).mockImplementation(async (opts) => {
    const job = (id: string) => ({ id, setId: 's1', key: `alice/${id}`, input: { text: 'Hi.' } }) as never
    opts.onEvent?.({ type: 'failed', job: job('j6'), reason: 'the model worker crashed', error: new kokoro.KokoroError('the model worker crashed', 'worker') }, 'books')
    opts.onEvent?.({ type: 'failed', job: job('j7'), reason: 'gone', error: new GenerationError('gone', 403) }, 'books')
    return { submitted: 0, stopped: 'no-work' }
  })
  await render()
  await click(button('Start')!)
  const runs = JSON.parse(localStorage.getItem('fas:generate-runs')!)
  expect(runs.find((r: { jobId: string }) => r.jobId === 'j6')).toMatchObject({ outcome: 'failed', record: { reason: 'model_error' } })
  expect(runs.find((r: { jobId: string }) => r.jobId === 'j7')).toMatchObject({ outcome: 'failed', record: { reason: 'lease_403' } })
})

it('copies diagnostics without the input text (#813)', async () => {
  localStorage.setItem('fas:generate-runs', JSON.stringify([{
    appId: 'books', setId: 's1', jobId: 'j9', key: 'alice/9', at: 1, outcome: 'skipped', reason: 'unknown voice zz', ms: 5,
    text: 'SECRET INPUT', chars: 12, record: { runner: 'browser', reason: 'unsupported' },
  }]))
  const writeText = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await render()
  await tab('Settings')
  await click(button('Copy diagnostics')!)
  const copied = JSON.parse(writeText.mock.calls[0]![0])
  expect(copied.capabilities).toMatchObject({ runner: 'browser', accelerator: 'webgpu', model: 'kokoro v1.0' })
  expect(copied.runs[0]).toMatchObject({ jobId: 'j9', reason: 'unknown voice zz', record: { reason: 'unsupported' } })
  expect(JSON.stringify(copied)).not.toContain('SECRET')
  expect(container.textContent).toContain('Copied.')
})

it('runs in one tab at a time: another tab holding the Web Lock blocks Start', async () => {
  localStorage.setItem('fas:generate-apps', JSON.stringify(['books']))
  localStorage.setItem('fas:generate-model', '1')
  vi.mocked(kokoro.isKokoroDownloaded).mockResolvedValue(true)
  const request = vi.fn(async (_name: string, _opts: unknown, cb: (lock: unknown) => Promise<void>) => cb(null))
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  await render()
  await click(button('Start')!)
  expect(request.mock.calls[0]!.slice(0, 2)).toEqual(['fas:generate', { ifAvailable: true }])
  expect(kokoro.contributeKokoroApps).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Already generating in another console tab')
  delete (navigator as { locks?: unknown }).locks
})

it('opens Activity filtered from today’s chips, filters by app, and plays an accepted job in its detail', async () => {
  const now = Date.now()
  const artifact = { url: `${api}/apps/books/generation/artifacts/j2?v=1`, metaUrl: `${api}/apps/books/generation/artifacts/j2/meta?v=1` }
  submissions = [
    submission,
    {
      ...submission, submissionId: 'x2', jobId: 'j2', key: 'alice/1', status: 'accepted', reason: null, bytes: 9216,
      durationMs: 12_300, report: { good: true, note: null, at: now }, input: { text: 'Hello there. General Kenobi.' }, artifact,
    },
  ]
  localStorage.setItem('fas:generate-runs', JSON.stringify([
    { appId: 'books', setId: 's1', jobId: 'j2', key: 'alice/1', at: now - 1, outcome: 'submitted', reason: null, ms: 42_000, text: '', chars: 0 },
    { appId: 'books', setId: 's1', jobId: 'j4', key: 'alice/4', at: now - 2, outcome: 'skipped', reason: 'voice bf_emma is not English (US)', ms: 10, text: 'Cheerio.', chars: 8 },
    { appId: 'poems', setId: 's9', jobId: 'j9', key: 'bob/9', at: now - 3 * 86_400_000, outcome: 'failed', reason: 'network down', ms: 10, text: 'Roses.', chars: 6 },
  ]))
  await render()
  expect(button('Accepted 1')).toBeDefined()
  expect(button('Rejected 1')).toBeDefined()
  expect(button('Not done 1')!.getAttribute('aria-label')).toBe('1 not done today, show in Activity')

  await click(button('Not done 1')!)
  expect(container.querySelector('[role=tab][aria-selected=true]')!.textContent).toBe('Activity')
  expect(button('Not done')!.getAttribute('aria-pressed')).toBe('true')
  expect(container.textContent).toContain('voice bf_emma is not English (US)')
  expect(container.textContent).toContain('network down')
  expect(container.textContent).not.toContain('audio is too long')

  // By app
  const select = container.querySelector('select')!
  await act(async () => {
    select.value = 'poems'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(container.textContent).toContain('bob/9')
  expect(container.textContent).not.toContain('alice/4')

  await act(async () => {
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await click(button('All')!)
  expect(container.textContent).toContain('Today')
  expect(container.textContent).toContain('audio is too long for the text')

  // Detail of the accepted job: verdict, size, the server's duration, this account's report and text, Play
  // with sentence highlighting from its meta
  const row = [...container.querySelectorAll('li button')].find((b) => b.textContent?.includes('alice/1')) as HTMLElement
  await click(row)
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(dialog.textContent).toContain('books · Free books')
  expect(dialog.textContent).toContain('Accepted')
  expect(dialog.textContent).toContain('9 KB')
  expect(dialog.textContent).toContain('12.3 s')
  expect(dialog.textContent).toContain('You said Good')
  expect(dialog.textContent).toContain('42.0 s')
  const audio = dialog.querySelector('audio')!
  expect(audio.getAttribute('src')).toBe(artifact.url)
  expect(dialog.textContent).toContain('Hello there. General Kenobi.')
  await act(async () => audio.dispatchEvent(new Event('play')))
  await flush()
  expect(fetch).toHaveBeenCalledWith(artifact.metaUrl)
  Object.defineProperty(audio, 'currentTime', { value: 1.5, configurable: true })
  await act(async () => audio.dispatchEvent(new Event('timeupdate')))
  expect(dialog.querySelector('mark')!.textContent).toBe('General Kenobi.')

  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.querySelector('[role=dialog]')).toBeNull()
})

it('shows the text and duration of a job another device ran, which this browser has no record of, and takes a report (#831)', async () => {
  await render()
  await tab('Activity')
  const row = [...container.querySelectorAll('li button')].find((b) => b.textContent?.includes('alice/0')) as HTMLElement
  await click(row)
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.textContent).toContain('Rejected')
  expect(dialog.textContent).toContain('3.0 s')
  expect(dialog.textContent).toContain('Call me Ishmael.')
  expect(dialog.textContent).not.toContain('Generating took')
  expect(dialog.querySelector('audio')).toBeNull()

  // Good / Not good with a note, sent for this account's own upload
  const inDialog = (text: string) => [...dialog.querySelectorAll('button')].find((b) => b.textContent === text)!
  expect(inDialog('Send').disabled).toBe(true)
  await click(inDialog('Not good'))
  expect(inDialog('Not good').getAttribute('aria-pressed')).toBe('true')
  const note = dialog.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'mumbles')
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(inDialog('Send'))
  const sent = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/submissions/x1/report'))!
  expect(sent[1]).toEqual(expect.objectContaining({ method: 'PUT' }))
  expect(JSON.parse(sent[1]!.body as string)).toEqual({ good: false, note: 'mumbles' })
  expect(document.querySelector('[role=dialog]')!.textContent).toContain('You said Not good')
  expect(container.textContent).toContain('Not good')
})

it('shows the job in hand as In progress with a live detail, and its audio once encoded (#838)', async () => {
  localStorage.setItem('fas:generate-apps', JSON.stringify(['books']))
  localStorage.setItem('fas:generate-model', '1')
  vi.mocked(kokoro.isKokoroDownloaded).mockResolvedValue(true)
  submissions = []
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const job = {
    id: 'j6', setId: 's1', key: 'alice/6', input: { text: 'Once upon a time.' }, model: 'kokoro', modelVersion: 'v1.0',
    params: { voice: 'af_heart' }, leaseExpiresAt: Date.now() + 600_000,
  } as never
  let emit: (e: kokoro.KokoroEvent) => void = () => {}
  vi.mocked(kokoro.contributeKokoroApps).mockImplementation(async (opts) => {
    emit = (e) => opts.onEvent?.(e, 'books')
    emit({ type: 'claimed', job })
    await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve()))
    return { submitted: 0, stopped: 'aborted' }
  })
  await render()
  await click(button('Start')!)
  // On the record from the claim
  expect(JSON.parse(localStorage.getItem('fas:generate-runs')!)).toMatchObject([{ jobId: 'j6', outcome: 'generating' }])
  expect(button('In progress 1')).toBeDefined()
  await click(button('Details')!)
  const dialog = () => document.querySelector('[role=dialog]')!
  expect(dialog().textContent).toContain('kokoro v1.0 · af_heart')
  expect(dialog().textContent).toContain('Starting…')
  expect(dialog().textContent).toContain('not measured in a browser')
  expect(dialog().textContent).toMatch(/expires in \d+\.\d s/)
  await act(async () => emit({ type: 'progress', job, progress: { sentence: 2, sentences: 5, chars: 40, totalChars: 100, charsPerSecond: 12 } }))
  expect(dialog().textContent).toContain('Sentence 2 of 5 · 40 of 100 characters')
  const file = new Blob([new Uint8Array(8)], { type: 'audio/mp4' })
  await act(async () => emit({ type: 'generated', job, result: { file, meta: { segments: [] } } }))
  expect(dialog().querySelector('audio')!.getAttribute('src')).toBe('blob:audio')

  // Stopped: it leaves In progress with the reason
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  await tab('Status')
  await click(button('Stop')!)
  expect(JSON.parse(localStorage.getItem('fas:generate-runs')!)).toMatchObject([{ jobId: 'j6', outcome: 'stopped', reason: 'stopped before it finished' }])
  expect(button('In progress 0')).toBeDefined()
})

it('a job left In progress by a closed page is shown interrupted (#838)', async () => {
  localStorage.setItem('fas:generate-runs', JSON.stringify([
    { appId: 'books', setId: 's1', jobId: 'j7', key: 'alice/7', at: Date.now(), outcome: 'generating', reason: null, ms: 0, text: 'Hi.', chars: 3 },
  ]))
  await render()
  expect(JSON.parse(localStorage.getItem('fas:generate-runs')!)).toMatchObject([
    { jobId: 'j7', outcome: 'stopped', reason: 'interrupted: the console closed before it finished' },
  ])
  expect(button('Not done 1')).toBeDefined()
})

it('downloads an attempt’s full record as record.json and its audio (#843)', async () => {
  const artifact = { url: `${api}/apps/books/generation/artifacts/j2?v=1`, metaUrl: null }
  submissions = [{ ...submission, submissionId: 'x2', jobId: 'j2', key: 'alice/1', status: 'accepted', reason: null, artifact }]
  localStorage.setItem('fas:generate-runs', JSON.stringify([
    { appId: 'books', setId: 's1', jobId: 'j2', key: 'alice/1', at: Date.now(), outcome: 'submitted', reason: null, ms: 4000, text: 'Call me Ishmael.', chars: 16, record: { runner: 'browser', reason: 'submitted', synthMs: 900 } },
  ]))
  const saved: { name: string; blob: Blob }[] = []
  const blobs = new Map<string, Blob>()
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { const u = `blob:${blobs.size}`; blobs.set(u, b as Blob); return u })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: blobs.get(this.href)! })
  })
  const fetchMock = vi.mocked(fetch)
  const base = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url, init) =>
    url === artifact.url ? new Response(new Blob([new Uint8Array(4)], { type: 'audio/mp4' })) : base(url, init))
  await render()
  await tab('Activity')
  const row = [...container.querySelectorAll('li button')].find((b) => b.textContent?.includes('alice/1')) as HTMLElement
  await act(async () => row.click())
  await flush()
  await act(async () => button('Download record')!.click())
  await flush()
  expect(saved.map((s) => s.name)).toEqual(['books-alice_1.record.json', 'books-alice_1.m4a'])
  const record = JSON.parse(await saved[0]!.blob.text())
  expect(record).toMatchObject({
    appId: 'books', jobId: 'j2', key: 'alice/1', status: 'Accepted', submissionId: 'x2',
    input: { text: 'Call me Ishmael.', chars: 16, whole: true },
    run: { outcome: 'submitted', ms: 4000, record: { synthMs: 900 } }, artifact,
  })
  click.mockRestore()
})

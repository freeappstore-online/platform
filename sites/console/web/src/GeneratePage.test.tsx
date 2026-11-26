// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GenerationError, type FreeAppStore, type GenerationOpenApp } from '@freeappstore/sdk'
import * as kokoro from '@freeappstore/sdk/generation-kokoro'
import { endReason } from './generate'
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
  reason: 'transcript does not match the text (word error rate 0.41)',
  bytes: 4096, contentType: 'audio/mp4', createdAt: Date.now(), decidedAt: Date.now(),
  wer: 0.41, durationMs: 3000, input: { text: 'Call me Ishmael.' }, artifact: null,
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

it('maps how a job ended to the #813 reasons', () => {
  expect(endReason('submitted', null)).toBe('submitted')
  expect(endReason('skipped', 'audio exceeds maxBytes')).toBe('too_large')
  expect(endReason('skipped', 'too slow to finish within the lease')).toBe('lease_cap')
  expect(endReason('skipped', 'unknown voice zz')).toBe('unsupported')
  expect(endReason('stopped', 'the lease ran out before it finished')).toBe('lease_cap')
  expect(endReason('stopped', 'stopped before it finished')).toBe('user_stop')
  expect(endReason('failed', 'x', new GenerationError('gone', 403))).toBe('lease_403')
  expect(endReason('failed', 'x', new GenerationError('down', 503))).toBe('server_5xx')
  expect(endReason('failed', 'Failed to fetch', new TypeError('Failed to fetch'))).toBe('network')
  expect(endReason('failed', 'worker crashed')).toBe('other')
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
      wer: 0.025, durationMs: 12_300, input: { text: 'Hello there. General Kenobi.' }, artifact,
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
  expect(container.textContent).not.toContain('word error rate')

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
  expect(container.textContent).toContain('word error rate 0.41')

  // Detail of the accepted job: verdict, size, the server's duration, error rate and text, Play
  // with sentence highlighting from its meta
  const row = [...container.querySelectorAll('li button')].find((b) => b.textContent?.includes('alice/1')) as HTMLElement
  await click(row)
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(dialog.textContent).toContain('books · Free books')
  expect(dialog.textContent).toContain('Accepted')
  expect(dialog.textContent).toContain('9 KB')
  expect(dialog.textContent).toContain('12.3 s')
  expect(dialog.textContent).toContain('2.5%')
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

it('shows the text, error rate and duration of a job another device ran, which this browser has no record of', async () => {
  await render()
  await tab('Activity')
  const row = [...container.querySelectorAll('li button')].find((b) => b.textContent?.includes('alice/0')) as HTMLElement
  await click(row)
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.textContent).toContain('Rejected')
  expect(dialog.textContent).toContain('41.0%')
  expect(dialog.textContent).toContain('3.0 s')
  expect(dialog.textContent).toContain('Call me Ishmael.')
  expect(dialog.textContent).not.toContain('Generating took')
  expect(dialog.querySelector('audio')).toBeNull()
})

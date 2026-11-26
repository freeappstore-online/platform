// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FreeAppStore, GenerationOpenApp } from '@freeappstore/sdk'
import * as kokoro from '@freeappstore/sdk/generation-kokoro'
import { GeneratePage } from './GeneratePage'

const load = vi.fn(async (onLoading?: (p: number) => void) => { onLoading?.(0.5) })
vi.mock('@freeappstore/sdk/generation-kokoro', async (actual) => ({
  ...(await actual<typeof import('@freeappstore/sdk/generation-kokoro')>()),
  kokoroEncoder: vi.fn(),
  kokoroDevice: vi.fn(async () => 'webgpu'),
  isKokoroDownloaded: vi.fn(async () => false),
  deleteKokoroModel: vi.fn(async () => {}),
  contributeKokoro: vi.fn(),
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
  sets: [{ setId: 's1', kind: 'tts', model: 'kokoro', modelVersion: 'v1.0', params: { voice: 'af_heart' }, formats: ['audio/mp4'], maxBytes: 25_000_000, open: 12 }],
}
const other: GenerationOpenApp = {
  appId: 'radio', oneliner: null,
  sets: [{ setId: 's2', kind: 'tts', model: 'piper', modelVersion: '1', params: {}, formats: ['audio/ogg'], maxBytes: 1, open: 3 }],
}
const submission = {
  submissionId: 'x1', jobId: 'j1', setId: 's1', key: 'alice/0', status: 'rejected', reason: 'asr mismatch',
  bytes: 4096, contentType: 'audio/mp4', createdAt: Date.now(), decidedAt: Date.now(),
}

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.mocked(kokoro.kokoroEncoder).mockResolvedValue(encoder)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === `${api}/generation/open`) return new Response(JSON.stringify({ apps: [books, other] }))
    if (url === `${api}/apps/books/generation/submissions`) return new Response(JSON.stringify({ submissions: [submission] }))
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

it('explains and hides the runner where WebCodecs AAC is missing', async () => {
  vi.mocked(kokoro.kokoroEncoder).mockResolvedValue(null)
  await render()
  expect(container.textContent).toContain("This browser can't generate")
  expect(container.textContent).toContain('AAC')
  expect(button('Start')).toBeUndefined()
  expect(button('Download')).toBeUndefined()
})

it('lists apps with open work, opts in per app, and downloads the model only after the creator agrees', async () => {
  await render()
  expect(container.textContent).toContain('books')
  expect(container.textContent).toContain('12 open')
  expect(container.textContent).toContain("can't run it (model piper 1)")
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
  expect(boxes[1]!.disabled).toBe(true)
  expect(container.textContent).toContain('window stays open')

  // Nothing is downloaded until the creator asks, with the size shown
  expect(load).not.toHaveBeenCalled()
  expect(button('Download the model (326 MB)')).toBeDefined()
  expect(button('Start')!.disabled).toBe(true)

  await act(async () => boxes[0]!.click())
  await flush()
  expect(JSON.parse(localStorage.getItem('fas:generate-apps')!)).toEqual(['books'])
  expect(container.textContent).toContain('asr mismatch')
  expect(container.textContent).toContain('alice/0')

  await act(async () => button('Download the model')!.click())
  await flush()
  expect(load).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Downloaded and kept in this browser')
  expect(button('Start')!.disabled).toBe(false)
})

it('generates for the opted-in apps’ runnable sets, shows progress, and stops', async () => {
  localStorage.setItem('fas:generate-apps', JSON.stringify(['books', 'radio']))
  localStorage.setItem('fas:generate-model', '1')
  vi.mocked(kokoro.isKokoroDownloaded).mockResolvedValue(true)
  let finish = () => {}
  vi.mocked(kokoro.contributeKokoro).mockImplementation(async (_generation, opts) => {
    const job = { key: 'alice/3' } as never
    opts.onEvent?.({ type: 'claimed', job })
    opts.onEvent?.({ type: 'progress', job, progress: { sentence: 4, sentences: 10, chars: 400, totalChars: 1000, charsPerSecond: 21.5 } })
    await new Promise<void>((resolve) => { finish = resolve; opts.signal.addEventListener('abort', () => resolve()) })
    return { submitted: 0, stopped: 'aborted' }
  })
  await render()
  await act(async () => button('Start')!.click())
  await flush()
  expect(kokoro.contributeKokoro).toHaveBeenCalledOnce()
  expect(vi.mocked(kokoro.contributeKokoro).mock.calls[0]![1].setId).toBe('s1')
  expect(container.textContent).toContain('alice/3')
  expect(container.textContent).toContain('Sentence 4 of 10')
  expect(container.textContent).toContain('21.5 characters per second')

  await act(async () => button('Stop')!.click())
  await flush()
  expect(container.textContent).toContain('Stopped.')
  expect(button('Start')).toBeDefined()
  finish()
})

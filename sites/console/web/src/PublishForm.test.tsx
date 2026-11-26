// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PublishForm } from './PublishForm'
import { ProjectPicker } from './builder/components/ProjectPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const getToken = () => 'token'
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// #757: a failed GET /v1/apps/mine read as "you have no apps".
it('PublishForm shows a load error with Retry, not "No apps yet", when the apps fetch fails', async () => {
  const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<PublishForm getToken={getToken} />))
  await flush()
  expect(container.textContent).not.toContain('No apps yet')
  expect(container.textContent).toContain("Couldn't load your apps.")

  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ apps: [] })))
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
  act(() => retry.click())
  await flush()
  expect(container.textContent).toContain('No apps yet')
})

it('ProjectPicker says the published apps could not be loaded when the fetch fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
  await act(async () =>
    root.render(
      <ProjectPicker projects={[]} currentId={null} onSelect={() => {}} onCreate={() => {}} onOpenApp={() => {}} onClose={() => {}} />,
    ),
  )
  await flush()
  expect(container.textContent).toContain("Couldn't load your published apps.")
})

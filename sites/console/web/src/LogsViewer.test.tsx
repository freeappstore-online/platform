// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LogsViewer } from './LogsViewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const getToken = () => 'token'

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

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

// #772: the build banner was only ever set, so it outlived the logs it came from.
it('clears the build banner when a reload returns no build metadata', async () => {
  let logs: unknown[] = [{ ts: 0, level: 'info', category: 'app', message: 'hi', userId: 'u', build: { appVersion: '1.2.3' } }]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ logs }))))

  await act(async () => root.render(<LogsViewer appId="demo" getToken={getToken} />))
  await flush()
  expect(container.textContent).toContain('v1.2.3')

  logs = []
  await act(async () => button('Refresh')!.click())
  await flush()
  expect(container.textContent).not.toContain('v1.2.3')
})

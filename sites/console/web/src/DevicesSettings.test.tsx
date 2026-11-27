// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DevicesSettings, type NativeDevice } from './DevicesSettings'

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
  vi.useRealTimers()
})

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
const desktop: NativeDevice = {
  id: 'd1',
  label: 'FreeAppStore desktop (Mac)',
  client: 'desktop',
  version: '0.4.0 (57, abc1234)',
  createdAt: Date.UTC(2026, 10, 1),
  lastSeenAt: Date.UTC(2026, 10, 27),
  expiresAt: Date.UTC(2027, 1, 1),
  pairedBy: null,
}
const phone: NativeDevice = { ...desktop, id: 'd2', label: 'Pixel 9', client: 'android', version: '1.2.0 (88, def5678)', pairedBy: 'console' }

// #833: the device list with versions, and Revoke
it('lists devices with the version each runs and revokes one', async () => {
  let list = [desktop]
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      list = []
      return Response.json({ revoked: true })
    }
    return Response.json({ devices: list })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('confirm', () => true)
  await act(async () => root.render(<DevicesSettings getToken={getToken} />))
  await flush()
  expect(container.textContent).toContain('FreeAppStore desktop (Mac)')
  expect(container.textContent).toContain('Computer · Version 0.4.0 (57, abc1234)')
  expect(fetchMock.mock.calls[0]![0]).toBe('https://api.freeappstore.online/v1/native/devices')

  await act(async () => button('Revoke')!.click())
  await flush()
  expect(fetchMock.mock.calls.find(([, i]) => i?.method === 'DELETE')![0]).toBe(
    'https://api.freeappstore.online/v1/native/devices/d1',
  )
  expect(container.textContent).toContain('No phones or computers')
})

// #845: Add a phone shows a QR and the code, and closes when the phone appears
it('shows a pairing QR and code until the new phone is connected', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  let list = [desktop]
  const fetchMock = vi.fn(async (url: string) =>
    url.endsWith('/pair-codes')
      ? Response.json({ code: 'ABCD-EFGH-JKMN-PQRS', url: 'freeappstore://native/pair?code=ABCDEFGHJKMNPQRS', expiresAt: Date.now() + 300_000 })
      : Response.json({ devices: list }),
  )
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => root.render(<DevicesSettings getToken={getToken} />))
  await flush()
  await act(async () => button('Add a phone')!.click())
  await flush()
  expect(container.querySelector('[data-testid="pair-code"]')?.textContent).toBe('ABCD-EFGH-JKMN-PQRS')
  expect(container.querySelector('svg[aria-label="Pairing QR code"] path')?.getAttribute('d')).toMatch(/^M\d/)
  expect(container.textContent).toContain('Works once, for 5:00 more')

  list = [phone, desktop]
  await act(async () => vi.advanceTimersByTime(3000))
  await flush()
  expect(container.querySelector('[data-testid="pair-code"]')).toBeNull()
  expect(container.textContent).toContain('Pixel 9 is connected.')
  expect(container.textContent).toContain('by a code from the console')
})

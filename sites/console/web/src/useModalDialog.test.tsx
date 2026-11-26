// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PublishModal } from './builder/components/studio/PublishModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const key = (k: string, shiftKey = false) =>
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })) })

// #767: the publish modal was a plain div — no dialog role, Escape, or focus handling.
it('is a labelled modal dialog that traps focus, closes on Escape and restores focus', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const onClose = vi.fn()
  act(() => root.render(<PublishModal appId="demo-app" appName="Demo" onClose={onClose} onPublished={() => {}} />))

  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Publish to Store')
  expect(document.activeElement).toBe(dialog)
  expect(container.querySelector('button[aria-label="Close"]')).not.toBeNull()
  for (const control of dialog.querySelectorAll('input, select')) {
    expect(dialog.querySelector(`label[for="${control.id}"]`)).not.toBeNull()
  }

  const buttons = dialog.querySelectorAll<HTMLElement>('button')
  const last = buttons[buttons.length - 1]!
  last.focus()
  key('Tab')
  expect(document.activeElement).toBe(buttons[0])
  key('Tab', true)
  expect(document.activeElement).toBe(last)

  key('Escape')
  expect(onClose).toHaveBeenCalledOnce()
  act(() => root.render(<></>))
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

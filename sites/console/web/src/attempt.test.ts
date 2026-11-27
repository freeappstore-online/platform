import { expect, test } from 'vitest'
import { attemptRows } from './attempt'

const speed = (rtf: number) => attemptRows({ runner: 'browser', reason: 'submitted', rtf }).find(([l]) => l === 'Speed')?.[1]

test('speed says how much faster than real time only when it is faster', () => {
  expect(speed(0.25)).toBe('0.25× real time to synthesize (4.0× faster)')
  expect(speed(2)).toBe('2.00× real time to synthesize')
  expect(speed(1)).toBe('1.00× real time to synthesize')
})

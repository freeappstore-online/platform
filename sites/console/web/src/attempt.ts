import type { GenerationAttemptRecord } from '@freeappstore/sdk'

const ms = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)} s` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`)
const battery = (level?: number, charging?: boolean) =>
  level === undefined ? (charging === undefined ? null : charging ? 'charging' : 'on battery')
    : `${Math.round(level)}%${charging ? ' charging' : ''}`
const span = (start: string | null | undefined, end: string | null | undefined) =>
  !start && !end ? null : start === end || !end ? start! : `${start ?? '?'} → ${end}`

/**
 * An attempt record (#827) as label/value rows, the numbers it has only: the device, how it ran and
 * ended, wall time per stage, CPU time, speed, memory, battery and thermal state.
 */
export function attemptRows(r: GenerationAttemptRecord): [string, string][] {
  const stages = ([['load', r.loadMs], ['synthesis', r.synthMs], ['encode', r.encodeMs], ['upload', r.uploadMs]] as const)
    .filter(([, n]) => n !== undefined)
    .map(([name, n]) => `${name} ${ms(n!)}`)
  const rows: [string, string | null | undefined][] = [
    ['Runner', [r.runner, r.appVersion].filter(Boolean).join(' ')],
    ['Device', [r.device, r.os].filter(Boolean).join(' · ') || null],
    ['Ran', [r.background === undefined ? null : r.background ? 'in the background' : 'in the foreground', r.network].filter(Boolean).join(' · ') || null],
    ['Ended', r.error ? `${r.reason}: ${r.error}` : r.reason],
    ['Wall time', r.wallMs === undefined ? null : ms(r.wallMs)],
    ['Stages', stages.join(' · ') || null],
    ['CPU time', r.cpuMs === undefined ? null : ms(r.cpuMs)],
    ['Speed', r.rtf === undefined ? null : `${r.rtf.toFixed(2)}× real time to synthesize${r.rtf > 0 && r.rtf < 1 ? ` (${(1 / r.rtf).toFixed(1)}× faster)` : ''}`],
    ['Peak memory', r.peakMemMb === undefined ? null : `${Math.round(r.peakMemMb)} MB`],
    ['Battery', span(battery(r.batteryStart, r.chargingStart), battery(r.batteryEnd, r.chargingEnd))],
    ['Thermal', span(r.thermalStart, r.thermalEnd)],
  ]
  return rows.filter((row): row is [string, string] => !!row[1])
}

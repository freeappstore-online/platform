import { useCallback, useEffect, useRef, useState } from 'react'
import { encode } from 'uqr'
import { API_URL, authHeaders } from './builder/lib/api'

/** A paired phone or computer (#833), from `GET /v1/native/devices`. */
export interface NativeDevice {
  id: string
  label: string
  client: 'android' | 'ios' | 'desktop' | null
  /** The app's version label, as it last reported it ("0.4.0 (57, abc1234)"). */
  version: string | null
  createdAt: number
  lastSeenAt: number | null
  expiresAt: number
  /** Null for the browser flow; `console` or the device that showed the code (#845). */
  pairedBy: string | null
}

interface PairCode {
  code: string
  url: string
  expiresAt: number
}

const KIND = { android: 'Android', ios: 'iPhone', desktop: 'Computer' }
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
/** How often the list is read again while a code is shown, to see the phone arrive. */
const POLL_MS = 3000

/** `text` as a QR code, dark on white whatever the theme, so every camera reads it. */
export function QrCode({ text }: { text: string }) {
  const { size, data } = encode(text, { border: 2 })
  const path = data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : ''))).join('')
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing QR code"
      className="h-48 w-48 rounded-lg"
    >
      <rect width={size} height={size} className="fill-white" />
      <path d={path} className="fill-black" />
    </svg>
  )
}

/**
 * The account's paired devices with the version each runs (#833), Revoke, and
 * Add a phone: a 5-minute, single-use code shown as a QR for the phone app to
 * scan (#845, docs/native-companion.md).
 */
export function DevicesSettings({ getToken }: { getToken: () => string | null }) {
  const [devices, setDevices] = useState<NativeDevice[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pair, setPair] = useState<PairCode | null>(null)
  const [now, setNow] = useState(Date.now)
  const known = useRef<Set<string>>(new Set())

  const load = useCallback(async () => {
    const res = await fetch(`${API_URL}/v1/native/devices`, { headers: authHeaders(getToken()) }).catch(() => null)
    if (!res?.ok) {
      setError('Could not load your devices.')
      return null
    }
    const list = ((await res.json()) as { devices: NativeDevice[] }).devices
    setError('')
    setDevices(list)
    return list
  }, [getToken])

  useEffect(() => {
    void load()
  }, [load])

  // While a code is shown: count down, and close it once the new device appears.
  useEffect(() => {
    if (!pair) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(async () => {
      const added = (await load())?.find((d) => !known.current.has(d.id))
      if (added) {
        setPair(null)
        setNotice(`${added.label} is connected.`)
      }
    }, POLL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [pair, load])

  const addPhone = async () => {
    setError('')
    setNotice('')
    known.current = new Set(devices?.map((d) => d.id))
    const res = await fetch(`${API_URL}/v1/native/pair-codes`, {
      method: 'POST',
      headers: authHeaders(getToken()),
    }).catch(() => null)
    if (!res?.ok) {
      setError(res?.status === 429 ? 'Too many codes today. Try again tomorrow.' : 'Could not make a code. Try again.')
      return
    }
    setNow(Date.now())
    setPair((await res.json()) as PairCode)
  }

  const revoke = async (device: NativeDevice) => {
    if (!confirm(`Revoke ${device.label}? It is signed out and stops sharing and contributing.`)) return
    const res = await fetch(`${API_URL}/v1/native/devices/${encodeURIComponent(device.id)}`, {
      method: 'DELETE',
      headers: authHeaders(getToken()),
    }).catch(() => null)
    if (!res?.ok) setError(`Could not revoke ${device.label}. Try again.`)
    await load()
  }

  const left = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0
  const button =
    'rounded-lg border border-[var(--line-strong)] px-4 py-2 text-sm font-medium text-muted hover:text-ink cursor-pointer'

  return (
    <div className="space-y-4">
      {devices === null && !error && <p className="text-sm text-muted">Loading devices…</p>}
      {devices?.length === 0 && (
        <p className="text-sm text-muted">No phones or computers are connected to your account.</p>
      )}
      {devices && devices.length > 0 && (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-panel">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0 space-y-0.5">
                <div className="font-semibold text-ink-strong">{d.label}</div>
                <div className="text-xs text-muted">
                  {[d.client && KIND[d.client], d.version ? `Version ${d.version}` : 'Version not reported yet']
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="text-xs text-muted">
                  Connected {when(d.createdAt)}
                  {d.pairedBy && ` by a code from ${d.pairedBy === 'console' ? 'the console' : d.pairedBy}`}
                  {d.lastSeenAt && ` · Last seen ${when(d.lastSeenAt)}`} · Expires {when(d.expiresAt)}
                </div>
              </div>
              <button type="button" onClick={() => revoke(d)} className={button}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {pair ? (
        <div className="rounded-2xl border border-line bg-panel p-5 flex flex-wrap items-center gap-5">
          {left > 0 && <QrCode text={pair.url} />}
          <div className="space-y-2 min-w-0">
            <p className="text-sm font-semibold text-ink-strong">Scan with the FreeAppStore app on your phone</p>
            <p className="text-sm text-muted">Or type this code in the app:</p>
            <p data-testid="pair-code" className="font-mono text-lg tracking-wider text-ink select-all">
              {pair.code}
            </p>
            <p className="text-xs text-muted">
              {left > 0
                ? `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more. Only scan a code you made yourself.`
                : 'This code expired.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {left === 0 && (
                <button type="button" onClick={addPhone} className={button}>
                  New code
                </button>
              )}
              <button type="button" onClick={() => setPair(null)} className={button}>
                {left > 0 ? 'Cancel' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button type="button" onClick={addPhone} className={button}>
          Add a phone
        </button>
      )}
      {notice && <p className="text-sm text-success">{notice}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}

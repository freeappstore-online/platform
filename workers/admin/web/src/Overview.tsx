import { useState, useEffect } from 'react'
import type { PlatformStats } from './api.ts'
import { api } from './api.ts'

export function Overview({ navigate }: { navigate: (h: string) => void }) {
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    api<PlatformStats>('/api/stats')
      .then(setStats)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} />

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Platform Overview</h1>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        <StatCard label="Apps" value={stats?.apps ?? 0} onClick={() => navigate('/apps')} />
        <StatCard label="Games (FGS)" value={stats?.games ?? 0} />
        <StatCard label="Routes" value={stats?.routes ?? 0} onClick={() => navigate('/apps')} />
        <StatCard label="Users" value={stats?.users ?? 0} />
        <StatCard label="Creators" value={stats?.creators ?? 0} />
        <StatCard label="VibeCode" value={stats?.agentSessions ?? 0} onClick={() => navigate('/agent')} />
      </div>

      {stats?.traffic && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TrafficCard title="FreeAppStore" data={stats.traffic.fas} />
          <TrafficCard title="FreeGameStore" data={stats.traffic.fgs} />
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      className="rounded-xl p-4 text-left"
      style={{ background: 'var(--panel)', border: '1px solid var(--line)', cursor: onClick ? 'pointer' : 'default' }}
    >
      <p className="text-sm font-medium" style={{ color: 'var(--muted)' }}>{label}</p>
      <p className="text-3xl font-bold mt-1" style={{ color: 'var(--ink)' }}>{value.toLocaleString()}</p>
    </Tag>
  )
}

function TrafficCard({ title, data }: { title: string; data: { totals: { requests: number; pageViews: number; visitors: number } } | null }) {
  if (!data) return null
  const { requests, pageViews, visitors } = data.totals
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      <p className="text-sm font-semibold mb-3" style={{ color: 'var(--ink)' }}>{title} (30d)</p>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-lg font-bold" style={{ color: 'var(--ink)' }}>{fmt(requests)}</p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Requests</p>
        </div>
        <div>
          <p className="text-lg font-bold" style={{ color: 'var(--ink)' }}>{fmt(pageViews)}</p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Page Views</p>
        </div>
        <div>
          <p className="text-lg font-bold" style={{ color: 'var(--ink)' }}>{fmt(visitors)}</p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Visitors</p>
        </div>
      </div>
    </div>
  )
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-20">
      <p style={{ color: 'var(--muted)' }}>Loading...</p>
    </div>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl p-4 mt-4" style={{ background: 'var(--panel)', border: '1px solid var(--error)' }}>
      <p className="text-sm font-medium" style={{ color: 'var(--error)' }}>Error: {message}</p>
    </div>
  )
}

export { Loading, ErrorBox }

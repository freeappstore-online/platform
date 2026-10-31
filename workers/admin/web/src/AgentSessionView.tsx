import { Button, Panel, StatusBadge } from './ui.tsx'
import { useState, useEffect } from 'react'
import type { AgentSessionDetail, AgentMessage } from './api.ts'
import { api } from './api.ts'
import { Loading, ErrorBox } from './Overview.tsx'

export function AgentSessionView({
  id,
  navigate,
}: {
  id: string
  navigate: (h: string) => void
}) {
  const [session, setSession] = useState<AgentSessionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    api<AgentSessionDetail>(`/api/agent/sessions/${encodeURIComponent(id)}`)
      .then(setSession)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!session) return <ErrorBox message="Session not found" />

  return (
    <div>
      <Button
        onClick={() => navigate('/agent')}
        className="text-sm font-medium mb-4 inline-flex items-center gap-1 text-muted"
      >
        &larr; Back to sessions
      </Button>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink">{session.name}</h1>
        <p className="text-sm mt-1 text-muted">
          Session {session.sessionId.slice(0, 16)}... &middot; User:{' '}
          {session.userId.slice(0, 12)}...
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <InfoCard label="Status">
          <StatusBadge
            status={session.deployed ? 'success' : 'idle'}
            label={
              session.deployed
                ? 'deployed'
                : (session.deployState?.phase ?? 'building')
            }
          />
        </InfoCard>
        <InfoCard label="App ID">
          {session.appId ? (
            <a
              onClick={() => navigate(`/apps/${session.appId}`)}
              className="text-sm font-mono cursor-pointer text-accent"
            >
              {session.appId}
            </a>
          ) : (
            <span className="text-sm text-muted">none</span>
          )}
        </InfoCard>
        <InfoCard label="Messages">
          <span className="text-lg font-bold text-ink">
            {session.messages.length}
          </span>
        </InfoCard>
        <InfoCard label="Created">
          <span className="text-sm text-ink">
            {formatDate(session.createdAt)}
          </span>
        </InfoCard>
      </div>

      {session.appUrl && (
        <Panel className="mb-6 p-4">
          <span className="text-sm font-medium text-muted">App URL: </span>
          <a
            href={session.appUrl}
            target="_blank"
            rel="noopener"
            className="text-sm underline text-accent"
          >
            {session.appUrl}
          </a>
        </Panel>
      )}

      <h2 className="text-lg font-bold mb-4 text-ink">
        Conversation ({session.messages.length} messages)
      </h2>

      <div className="space-y-3">
        {session.messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} index={i} />
        ))}
        {session.messages.length === 0 && (
          <div className="py-8 text-center text-muted">
            No messages in this session.
          </div>
        )}
      </div>
    </div>
  )
}

function InfoCard({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Panel className="p-3">
      <p className="text-xs font-medium mb-1 text-muted">{label}</p>
      {children}
    </Panel>
  )
}

function MessageBubble({ msg, index }: { msg: AgentMessage; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const isUser = msg.role === 'user'
  const content =
    typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  const truncated = content.length > 500 && !expanded

  return (
    <div
      className={`rounded-xl p-4 border border-l-[3px] ${isUser ? 'bg-accent-soft' : 'bg-panel'} ${isUser ? 'border-accent' : 'border-line'}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-xs font-bold uppercase ${isUser ? 'text-accent' : 'text-muted'}`}
        >
          {isUser ? 'User' : 'Agent'}
        </span>
        <span className="text-xs text-muted">#{index + 1}</span>
      </div>

      <pre className="text-sm whitespace-pre-wrap break-words text-ink [font-family:inherit]">
        {truncated ? content.slice(0, 500) + '...' : content}
      </pre>

      {content.length > 500 && (
        <Button
          onClick={() => setExpanded(!expanded)}
          className="text-xs mt-2 underline text-accent"
        >
          {expanded ? 'Show less' : `Show all (${content.length} chars)`}
        </Button>
      )}

      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="mt-3 space-y-1">
          {msg.toolCalls.map((tc, j) => (
            <div
              key={j}
              className="text-xs font-mono rounded px-2 py-1 bg-line text-ink"
            >
              {tc.name}({tc.input.path ? String(tc.input.path) : '...'})
            </div>
          ))}
        </div>
      )}

      {msg.toolResults && msg.toolResults.length > 0 && (
        <div className="mt-2 space-y-1">
          {msg.toolResults.map((tr, j) => (
            <details key={j} className="text-xs">
              <summary className="cursor-pointer font-mono text-muted">
                Tool result ({tr.content.length} chars)
              </summary>
              <pre className="mt-1 p-2 rounded text-xs overflow-x-auto bg-line text-ink">
                {tr.content.slice(0, 1000)}
                {tr.content.length > 1000 ? '...' : ''}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

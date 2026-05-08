import type * as React from 'react';
import { useState } from 'react';
import type { ReactNode } from 'react';

export interface GameTopbarStat {
  /** Short uppercase label, e.g. "Score", "Lives", "Level". */
  label: string;
  /** Display value — string or number. Shown big. */
  value: ReactNode;
  /**
   * Optional accent — flips the value's color to the platform accent
   * (typically used for the primary score).
   */
  accent?: boolean;
}

export interface GameTopbarProps {
  /** The game's display name. Shows on the left in Manrope. */
  title?: string;

  /**
   * Convenience: the most-common case. If present, renders as a single
   * "Score" stat. Equivalent to passing `stats: [{ label: 'Score',
   * value: score, accent: true }]`.
   */
  score?: number;

  /**
   * Custom stat lineup. Use for games that need more than just a score
   * (lives, level, time, etc.). Replaces the score-only convenience.
   */
  stats?: GameTopbarStat[];

  /**
   * Optional right-side action slot. Common: <button>Pause</button>,
   * <button>Reset</button>. Keep to ≤2 buttons — the topbar is brand
   * surface, not a settings menu.
   */
  actions?: ReactNode;

  /**
   * Game rules/instructions. When provided, an ℹ info icon appears in the
   * topbar. Tapping it opens a fullscreen overlay with the rules content.
   * Every game should populate this so players know how to play.
   */
  rules?: ReactNode;
}

/**
 * The single allowed topbar shape for FreeGameStore games. Brand
 * consistency: same font, same paddings, same color tokens, same stat
 * layout across every game on the storefront.
 *
 * Use inside <GameShell topbar={<GameTopbar … />}>.
 */
export function GameTopbar({ title, score, stats, actions, rules }: GameTopbarProps): React.JSX.Element {
  const [showRules, setShowRules] = useState(false);

  const resolvedStats: GameTopbarStat[] =
    stats && stats.length > 0
      ? stats
      : score !== undefined
        ? [{ label: 'Score', value: score, accent: true }]
        : [];

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          padding: '0.25rem 0.75rem',
          height: '2rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
          {rules !== undefined && (
            <button
              onClick={() => setShowRules(true)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                minWidth: '2.75rem',
                minHeight: '2.75rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--muted, #999)',
                fontSize: '1rem',
                lineHeight: 1,
                WebkitTapHighlightColor: 'transparent',
              }}
              aria-label="Game rules"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 11.5v0M8 5v4" />
              </svg>
            </button>
          )}
          {title !== undefined && (
            <span
              style={{
                fontFamily: '"Manrope", system-ui, sans-serif',
                fontWeight: 600,
                fontSize: '0.8rem',
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {title}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {resolvedStats.map((s) => (
            <Stat key={s.label} stat={s} />
          ))}
          {actions !== undefined && (
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>{actions}</div>
          )}
        </div>
      </div>

      {showRules && rules !== undefined && (
        <RulesOverlay onClose={() => setShowRules(false)}>{rules}</RulesOverlay>
      )}
    </>
  );
}

function RulesOverlay({ children, onClose }: { children: ReactNode; onClose: () => void }): React.JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--paper, #0f0f0f)',
        color: 'var(--ink, #f0f0f0)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.5rem 0.75rem',
          borderBottom: '1px solid var(--line, #2a2a2a)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: '"Manrope", system-ui, sans-serif',
            fontWeight: 700,
            fontSize: '0.9rem',
          }}
        >
          How to Play
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--muted, #999)',
            fontSize: '1.2rem',
            minWidth: '2.75rem',
            minHeight: '2.75rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            WebkitTapHighlightColor: 'transparent',
          }}
          aria-label="Close rules"
        >
          &times;
        </button>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '1rem',
          fontFamily: '"Manrope", system-ui, sans-serif',
          fontSize: '0.9rem',
          lineHeight: 1.6,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Stat({ stat }: { stat: GameTopbarStat }): React.JSX.Element {
  return (
    <div style={{ textAlign: 'right', lineHeight: 1.05 }}>
      <div
        style={{
          fontFamily: '"Manrope", system-ui, sans-serif',
          fontWeight: 800,
          fontSize: '0.85rem',
          color: stat.accent === true ? 'var(--accent)' : 'var(--ink)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}
      >
        {stat.value}
      </div>
      <div
        style={{
          fontSize: '0.5rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--muted)',
          lineHeight: 1,
        }}
      >
        {stat.label}
      </div>
    </div>
  );
}

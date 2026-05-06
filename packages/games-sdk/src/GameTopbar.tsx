import type * as React from 'react';
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
  /** The game's display name. Shows on the left in Fraunces. */
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
}

/**
 * The single allowed topbar shape for FreeGameStore games. Brand
 * consistency: same font, same paddings, same color tokens, same stat
 * layout across every game on the storefront.
 *
 * Use inside <GameShell topbar={<GameTopbar … />}>.
 */
export function GameTopbar({ title, score, stats, actions }: GameTopbarProps): React.JSX.Element {
  // Resolve the stat list: explicit `stats` wins; otherwise synthesize
  // from `score` if provided.
  const resolvedStats: GameTopbarStat[] =
    stats && stats.length > 0
      ? stats
      : score !== undefined
        ? [{ label: 'Score', value: score, accent: true }]
        : [];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '0.6rem 1rem',
        height: '3.25rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
        {title !== undefined && (
          <span
            style={{
              fontFamily: '"Fraunces", Georgia, serif',
              fontWeight: 700,
              fontSize: '1.05rem',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
        {resolvedStats.map((s) => (
          <Stat key={s.label} stat={s} />
        ))}
        {actions !== undefined && (
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>{actions}</div>
        )}
      </div>
    </div>
  );
}

function Stat({ stat }: { stat: GameTopbarStat }): React.JSX.Element {
  return (
    <div style={{ textAlign: 'right', lineHeight: 1.05 }}>
      <div
        style={{
          fontFamily: '"Fraunces", Georgia, serif',
          fontWeight: 700,
          fontSize: '1.15rem',
          color: stat.accent === true ? 'var(--accent)' : 'var(--ink)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {stat.value}
      </div>
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--muted)',
          marginTop: '0.1rem',
        }}
      >
        {stat.label}
      </div>
    </div>
  );
}

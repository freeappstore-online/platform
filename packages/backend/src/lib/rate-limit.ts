/**
 * Tiny per-second rate-limit window. Independent of the message handler so
 * its edge cases (window flip, exactly-at-limit, second rollover) can be
 * tested in isolation.
 *
 * Approximation: a fresh bucket per wall-clock second, NOT a sliding window.
 * That's intentional for v0 — sliding windows need a ring buffer per peer
 * and we want the cheapest enforcement that still bounds abuse.
 */
export interface RateLimitState {
  windowSecond: number;
  count: number;
}

export function newRateLimitState(nowMs: number): RateLimitState {
  return { windowSecond: Math.floor(nowMs / 1000), count: 0 };
}

/**
 * Try to consume one event from the bucket. Mutates `state` in place and
 * returns whether the event is allowed.
 *
 * The state mutation is intentional — it's hot-path code on every WebSocket
 * message and we don't want to allocate a new object per call.
 */
export function consume(state: RateLimitState, nowMs: number, limitPerSec: number): boolean {
  const second = Math.floor(nowMs / 1000);
  if (second !== state.windowSecond) {
    state.windowSecond = second;
    state.count = 0;
  }
  if (state.count >= limitPerSec) return false;
  state.count++;
  return true;
}

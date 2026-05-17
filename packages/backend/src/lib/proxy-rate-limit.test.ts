import { describe, expect, it } from 'vitest';
import { checkAndBump, dayKey, type ProxyUsageStore } from './proxy-rate-limit.js';

function fakeStore(initial: Record<string, number> = {}): ProxyUsageStore & {
  data: Record<string, number>;
  bumps: number;
} {
  const data: Record<string, number> = { ...initial };
  let bumps = 0;
  return {
    data,
    get bumps() {
      return bumps;
    },
    async read(appId, day) {
      return data[`${appId}|${day}`] ?? 0;
    },
    async bump(appId, day, by) {
      bumps++;
      const k = `${appId}|${day}`;
      data[k] = (data[k] ?? 0) + by;
    },
  };
}

describe('dayKey', () => {
  it('formats UTC day as YYYY-MM-DD', () => {
    expect(dayKey(Date.UTC(2026, 4, 14, 23, 59, 59))).toBe('2026-05-14');
    // 1ms past midnight UTC = next day, regardless of caller TZ.
    expect(dayKey(Date.UTC(2026, 4, 15, 0, 0, 0))).toBe('2026-05-15');
  });
});

describe('checkAndBump', () => {
  const APP = 'weather';
  const NOW = Date.UTC(2026, 4, 14, 12, 0, 0);
  const DAY = '2026-05-14';

  it('admits when under cap, never writes when RNG misses', async () => {
    const store = fakeStore();
    const r = await checkAndBump(store, {
      appId: APP,
      dailyLimit: 100,
      nowMs: NOW,
      rng: () => 0.99, // always miss with denom=10
    });
    expect(r).toEqual({ allowed: true, count: 0, wrote: false });
    expect(store.bumps).toBe(0);
  });

  it('admits and writes by `denom` when RNG hits', async () => {
    const store = fakeStore();
    const r = await checkAndBump(store, {
      appId: APP,
      dailyLimit: 100,
      nowMs: NOW,
      rng: () => 0.0, // always hit
    });
    expect(r).toEqual({ allowed: true, count: 10, wrote: true });
    expect(store.data[`${APP}|${DAY}`]).toBe(10);
  });

  it('with denominator=1, every call writes (test-only mode)', async () => {
    const store = fakeStore();
    for (let i = 0; i < 5; i++) {
      await checkAndBump(store, {
        appId: APP,
        dailyLimit: 100,
        nowMs: NOW,
        rng: () => 0.5,
        denominator: 1,
      });
    }
    expect(store.bumps).toBe(5);
    expect(store.data[`${APP}|${DAY}`]).toBe(5);
  });

  it('refuses when at or over the cap (and does not write)', async () => {
    const store = fakeStore({ [`${APP}|${DAY}`]: 100 });
    const r = await checkAndBump(store, {
      appId: APP,
      dailyLimit: 100,
      nowMs: NOW,
      rng: () => 0.0, // would have written if allowed
    });
    expect(r).toEqual({ allowed: false, count: 100, wrote: false });
    expect(store.bumps).toBe(0);
  });

  it('rolls over to a new day key on UTC midnight crossing', async () => {
    const store = fakeStore({ [`${APP}|2026-05-14`]: 9999 });
    // Day 14: at cap of 10000 — 9999 is still under, so allowed.
    const a = await checkAndBump(store, {
      appId: APP,
      dailyLimit: 10000,
      nowMs: Date.UTC(2026, 4, 14, 23, 59, 59),
      rng: () => 0.0,
    });
    expect(a.allowed).toBe(true);
    expect(store.data[`${APP}|2026-05-14`]).toBe(10009);

    // Cross midnight — new day, fresh counter.
    const b = await checkAndBump(store, {
      appId: APP,
      dailyLimit: 10000,
      nowMs: Date.UTC(2026, 4, 15, 0, 0, 1),
      rng: () => 0.0,
    });
    expect(b).toEqual({ allowed: true, count: 10, wrote: true });
    expect(store.data[`${APP}|2026-05-15`]).toBe(10);
  });

  it('expected count is unbiased: ~1000 calls × 0.1 hit rate × 10 = ~1000', async () => {
    const store = fakeStore();
    // Deterministic "10% hits": every 10th call.
    let i = 0;
    const rng = () => (i++ % 10 === 0 ? 0.0 : 0.99);
    for (let n = 0; n < 1000; n++) {
      await checkAndBump(store, {
        appId: APP,
        dailyLimit: 1_000_000,
        nowMs: NOW,
        rng,
      });
    }
    // 100 hits × 10 = 1000
    expect(store.data[`${APP}|${DAY}`]).toBe(1000);
    expect(store.bumps).toBe(100);
  });
});

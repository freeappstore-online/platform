// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { getCapability, installCapability } from './capability.js';
import { getPreference, setPreference } from './prefs.js';

afterEach(() => {
  localStorage.clear();
});

describe('storage capabilities', () => {
  it('installs at init and later without replacing the first install or saved preferences', () => {
    const name = `notes${Date.now()}`;
    setPreference(name, 'draft', { text: 'keep' });
    let calls = 0;
    const installer = () => {
      calls += 1;
      return { probe: () => ({ ok: true, value: true as const }) };
    };
    const first = installCapability(name, installer);
    const later = installCapability(name, installer);
    expect(calls).toBe(1);
    expect(first).toEqual(later);
    expect(getCapability(name)).toEqual(first);
    expect(getPreference(name, 'draft')).toEqual({ ok: true, value: { text: 'keep' } });
  });

  it('distinguishes a missing capability from an installed store that is unavailable', () => {
    const missing = `missing${Date.now()}`;
    const blocked = `blocked${Date.now()}`;
    expect(getCapability(missing)).toEqual({ ok: false, reason: 'not-installed' });
    installCapability(blocked, () => ({
      probe: () => ({ ok: false, reason: 'unavailable', detail: 'storage blocked' }),
    }));
    expect(getCapability(blocked)).toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'installed',
    });
    expect(getCapability(blocked).ok).toBe(false);
  });
});

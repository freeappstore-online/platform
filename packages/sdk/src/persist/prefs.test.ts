// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPreference,
  type PreferenceNotice,
  preferenceKey,
  removePreference,
  setPreference,
  watchPreference,
} from './prefs.js';

const isDraft = (value: unknown): value is { text: string } =>
  typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string';

class TestChannel {
  static byName = new Map<string, Set<TestChannel>>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {
    let group = TestChannel.byName.get(name);
    if (!group) {
      group = new Set();
      TestChannel.byName.set(name, group);
    }
    group.add(this);
  }
  postMessage(data: unknown) {
    const event = new MessageEvent('message', { data });
    for (const other of TestChannel.byName.get(this.name) ?? []) {
      if (other !== this) other.onmessage?.(event);
    }
  }
  close() {
    TestChannel.byName.get(this.name)?.delete(this);
  }
}

/**
 * Replace setItem and return a restore.
 * happy-dom's Storage proxy ignores assignment, and spyOn cannot read the
 * descriptor back, so the mock survives restoreAllMocks.
 */
function replaceSetItem(impl: (key: string, value: string) => void): () => void {
  const storage = localStorage;
  const original = storage.setItem;
  Object.defineProperty(storage, 'setItem', { configurable: true, writable: true, value: impl });
  return () => {
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  TestChannel.byName.clear();
});

describe('preference storage', () => {
  it('returns corrupt for malformed JSON and does not reset it', () => {
    const key = preferenceKey('notes', 'draft');
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    localStorage.setItem(key.value, '{');
    const result = getPreference('notes', 'draft', isDraft);
    expect(result).toEqual({
      ok: false,
      reason: 'corrupt',
      detail: 'Stored value is not valid JSON.',
    });
    expect(localStorage.getItem(key.value)).toBe('{');
  });

  it('returns validation for a readable value that fails the hook and keeps the bytes', () => {
    const key = preferenceKey('notes', 'draft');
    if (!key.ok) throw new Error('key');
    localStorage.setItem(key.value, JSON.stringify({ n: 1 }));
    const result = getPreference('notes', 'draft', isDraft);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('validation');
    expect(localStorage.getItem(key.value)).toBe(JSON.stringify({ n: 1 }));
  });

  it('returns unavailable when localStorage is blocked and writes nothing', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });
    expect(getPreference('notes', 'draft')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(setPreference('notes', 'draft', { text: 'x' })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(removePreference('notes', 'draft')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('returns quota when setItem exceeds storage and keeps the previous value', () => {
    const key = preferenceKey('notes', 'draft');
    if (!key.ok) throw new Error('key');
    localStorage.setItem(key.value, '{"text":"kept"}');
    const restore = replaceSetItem(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      const result = setPreference('notes', 'draft', { text: 'next' }, isDraft);
      expect(result).toMatchObject({ ok: false, reason: 'quota' });
      expect(localStorage.getItem(key.value)).toBe('{"text":"kept"}');
    } finally {
      restore();
    }
  });

  it('reports success only after setItem returns', () => {
    let storedDuringCall = 'unset';
    const original = localStorage.setItem.bind(localStorage);
    const restore = replaceSetItem((key: string, value: string) => {
      storedDuringCall = 'called';
      original(key, value);
    });
    try {
      const result = setPreference('notes', 'draft', { text: 'saved' }, isDraft);
      expect(storedDuringCall).toBe('called');
      expect(result).toEqual({ ok: true, value: { text: 'saved' } });
      expect(getPreference('notes', 'draft', isDraft)).toEqual({
        ok: true,
        value: { text: 'saved' },
      });
    } finally {
      restore();
    }
  });

  it('does not notify when the write fails', () => {
    vi.stubGlobal('BroadcastChannel', TestChannel);
    const seen: PreferenceNotice[] = [];
    watchPreference('notes', 'draft', (notice) => seen.push(notice));
    const restore = replaceSetItem(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      setPreference('notes', 'draft', { text: 'nope' }, isDraft);
      expect(seen).toEqual([]);
    } finally {
      restore();
    }
  });

  it('notifies another tab through the storage event without merging a value', () => {
    const seen: PreferenceNotice[] = [];
    const stop = watchPreference('notes', 'draft', (notice) => seen.push(notice));
    const key = preferenceKey('notes', 'draft');
    if (!key.ok) throw new Error('key');
    localStorage.setItem(key.value, JSON.stringify({ text: 'from-the-other-tab' }));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: key.value,
        newValue: localStorage.getItem(key.value),
        storageArea: localStorage,
      }),
    );
    expect(seen).toEqual([
      {
        namespace: 'notes',
        key: 'draft',
        kind: 'set',
        notification: 'storage-changed',
      },
    ]);
    expect(seen[0]).not.toHaveProperty('resolved');
    expect(getPreference('notes', 'draft', isDraft)).toEqual({
      ok: true,
      value: { text: 'from-the-other-tab' },
    });
    stop();
  });

  it('delivers a cross-context BroadcastChannel notice and ignores other keys', () => {
    vi.stubGlobal('BroadcastChannel', TestChannel);
    const seen: PreferenceNotice[] = [];
    const stop = watchPreference('notes', 'draft', (notice) => seen.push(notice));
    const saved = setPreference('notes', 'draft', { text: 'local' }, isDraft);
    setPreference('notes', 'other', { text: 'elsewhere' }, isDraft);
    expect(saved.ok).toBe(true);
    expect(seen).toEqual([
      {
        namespace: 'notes',
        key: 'draft',
        kind: 'set',
        notification: 'storage-changed',
      },
    ]);
    stop();
  });

  it('documents device-only storage against account-backed kv', () => {
    const doc = readFileSync(
      fileURLToPath(new NodeURL('../../../../docs/sdk.md', import.meta.url)),
      'utf8',
    );
    expect(doc).toContain('Device-local');
    expect(doc).toContain('fas.kv');
    expect(doc).toMatch(/not a merge and not conflict resolution/i);
    expect(doc).toContain('left in place');
  });
});

// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteRecord, getRecord, openStore, putRecord, withTransaction } from './idb-store.js';
import { settleTransaction } from './status.js';

const namespaces: string[] = [];

function namespace(): string {
  const name = `notes${namespaces.length}`;
  namespaces.push(name);
  return name;
}

async function opened(version = 1, upgrade?: Parameters<typeof openStore>[0]['upgrade']) {
  const ns = namespace();
  const store = await openStore({ namespace: ns, version, ...(upgrade ? { upgrade } : {}) });
  expect(store.ok).toBe(true);
  if (!store.ok) throw new Error('open');
  return store.value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of namespaces.splice(0)) {
    await deleteDB(`fas:${name}`);
  }
});

const isNote = (value: unknown): value is { text: string } =>
  typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string';

describe('IndexedDB records', () => {
  it('returns success only after the transaction promise settles', async () => {
    let completed = false;
    let settled = false;
    const done = new Promise<void>((resolve) => {
      setTimeout(() => {
        completed = true;
        resolve();
      }, 20);
    });
    const pending = settleTransaction(
      done,
      () => undefined,
      async () => 1,
    );
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    expect(settled).toBe(false);
    await expect(pending).resolves.toEqual({ ok: true, value: 1 });
    expect(completed).toBe(true);
  });

  it('returns aborted when the transaction is aborted and does not keep the write', async () => {
    const store = await opened();
    const result = await withTransaction(store, 'readwrite', async (tx) => {
      await tx.put('draft', { text: 'nope' });
      tx.abort();
      return true;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('aborted');
    const saved = await getRecord(store, 'draft');
    expect(saved).toEqual({ ok: true, value: undefined });
  });

  it('returns quota when a write exceeds the database quota and keeps the old record', async () => {
    const store = await opened();
    expect(await putRecord(store, 'draft', { text: 'kept' }, isNote)).toEqual({
      ok: true,
      value: { text: 'kept' },
    });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function rejectQuota() {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    try {
      const result = await putRecord(store, 'draft', { text: 'next' }, isNote);
      expect(result).toMatchObject({ ok: false, reason: 'quota' });
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    expect(await getRecord(store, 'draft', isNote)).toEqual({ ok: true, value: { text: 'kept' } });
  });

  it('returns unavailable when IndexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const result = await openStore({ namespace: 'blocked', version: 1 });
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('returns validation for an unreadable record and does not delete it', async () => {
    const store = await opened();
    expect(await putRecord(store, 'draft', { n: 1 })).toMatchObject({ ok: true });
    const result = await getRecord(store, 'draft', isNote);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('validation');
    expect(await getRecord(store, 'draft')).toEqual({ ok: true, value: { n: 1 } });
  });

  it('applies a versioned upgrade and preserves records from the previous schema', async () => {
    const ns = namespace();
    let seenOld = -1;
    const first = await openStore({ namespace: ns, version: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await putRecord(first.value, 'draft', { text: 'keep' }, isNote)).toMatchObject({
      ok: true,
    });
    first.value.close();
    const second = await openStore({
      namespace: ns,
      version: 2,
      upgrade(database, oldVersion) {
        seenOld = oldVersion;
        if (oldVersion < 2 && !database.objectStoreNames.contains('meta')) {
          database.createObjectStore('meta');
        }
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(seenOld).toBe(1);
    expect(second.value.database.objectStoreNames.contains('meta')).toBe(true);
    expect(await getRecord(second.value, 'draft', isNote)).toEqual({
      ok: true,
      value: { text: 'keep' },
    });
    second.value.close();
  });

  it('classifies a rejected transaction as aborted rather than success', async () => {
    const result = await settleTransaction(
      Promise.reject(new DOMException('The transaction was aborted.', 'AbortError')),
      () => undefined,
      async () => true,
    );
    expect(result).toMatchObject({ ok: false, reason: 'aborted' });
  });
});

describe.each(['explicit', 'versionchange'] as const)('%s close', (kind) => {
  it('contains every record transaction start and preserves old data', async () => {
    const store = await opened();
    await putRecord(store, 'draft', { text: 'kept' });
    if (kind === 'explicit') store.close();
    const next = await openStore({
      namespace: store.namespace,
      version: kind === 'explicit' ? 1 : 2,
    });
    if (!next.ok) throw new Error('reopen');
    try {
      const run = vi.fn(() => true);
      for (const operation of [
        () => getRecord(store, 'draft'),
        () => putRecord(store, 'draft', { text: 'lost' }),
        () => deleteRecord(store, 'draft'),
        () => withTransaction(store, 'readonly', run),
        () => withTransaction(store, 'readwrite', run),
      ])
        await expect(operation()).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
      expect(run).not.toHaveBeenCalled();
      expect(await getRecord(next.value, 'draft')).toEqual({ ok: true, value: { text: 'kept' } });
      expect(
        await withTransaction(next.value, 'readwrite', async (tx) => {
          await tx.put('second', 2);
          return tx.get('second');
        }),
      ).toEqual({ ok: true, value: 2 });
    } finally {
      next.value.close();
    }
  });
});

it('contains throwing transaction callbacks and rolls back their writes', async () => {
  const store = await opened();
  try {
    await putRecord(store, 'draft', 'kept');
    await expect(
      withTransaction(store, 'readwrite', async (tx) => {
        await tx.put('draft', 'lost');
        throw new Error('callback failed');
      }),
    ).resolves.toMatchObject({ ok: false, detail: 'callback failed' });
    expect(await getRecord(store, 'draft')).toEqual({ ok: true, value: 'kept' });
  } finally {
    store.close();
  }
});

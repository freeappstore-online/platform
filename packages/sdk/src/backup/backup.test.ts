// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPreference, setPreference } from '../persist/prefs.js';
import {
  type BackupSchema,
  exportBackup,
  type ImportMode,
  importBackup,
  previewBackup,
  registerBackupCapability,
  shareOrDownloadBackup,
} from './index.js';

interface Notes {
  notes: string[];
}

const exportedAt = '2026-11-04T00:00:00.000Z';

const notesSchema: BackupSchema<Notes> = {
  supportedVersions: [1],
  validate: (value): value is Notes =>
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as Notes).notes) &&
    (value as Notes).notes.every((note) => typeof note === 'string'),
  counts: (data) => ({ notes: data.notes.length }),
};

function memory() {
  const store: Notes = { notes: ['keep'] };
  const calls = { apply: 0, restore: 0, snapshot: 0 };
  return {
    store,
    calls,
    snapshot: () => {
      calls.snapshot += 1;
      return { notes: [...store.notes] };
    },
    apply: (data: Notes, _mode: ImportMode) => {
      calls.apply += 1;
      store.notes = [...data.notes];
    },
    restore: (snapshot: Notes) => {
      calls.restore += 1;
      store.notes = [...snapshot.notes];
    },
  };
}

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('backup envelope', () => {
  it('round-trips export and replace import, and previews counts before writing', async () => {
    const db = memory();
    const exported = await exportBackup({
      appId: 'notes',
      data: { notes: ['keep', 'next'] },
      exportedAt,
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.format).toBe('fas-backup');
    expect(exported.value.version).toBe(1);
    expect(exported.value.checksum).toMatch(/^[a-f0-9]{64}$/);

    const preview = await previewBackup(exported.value, notesSchema);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.preview.counts).toEqual({ notes: 2 });
    expect(db.calls.apply).toBe(0);

    const imported = await importBackup({
      raw: JSON.stringify(exported.value),
      mode: 'replace',
      schema: notesSchema,
      snapshot: db.snapshot,
      apply: db.apply,
      restore: db.restore,
    });
    expect(imported).toMatchObject({
      ok: true,
      value: { counts: { notes: 2 }, appId: 'notes', version: 1 },
    });
    expect(db.store.notes).toEqual(['keep', 'next']);
    expect(db.calls.restore).toBe(0);
  });

  it('passes merge to the app and does not replace on its own', async () => {
    const db = memory();
    const exported = await exportBackup({
      appId: 'notes',
      data: { notes: ['added'] },
      exportedAt,
    });
    if (!exported.ok) throw new Error('export failed');
    const imported = await importBackup({
      raw: exported.value,
      mode: 'merge',
      schema: notesSchema,
      snapshot: db.snapshot,
      apply: (data, mode) => {
        expect(mode).toBe('merge');
        db.store.notes = [...db.store.notes, ...data.notes];
      },
      restore: db.restore,
    });
    expect(imported.ok).toBe(true);
    expect(db.store.notes).toEqual(['keep', 'added']);
  });

  it('migrates an older supported version before counting it', async () => {
    const legacy = await exportBackup({
      appId: 'notes',
      data: ['from-v1'],
      version: 1,
      exportedAt,
    });
    if (!legacy.ok) throw new Error('export failed');
    const schema: BackupSchema<Notes> = {
      supportedVersions: [1, 2],
      currentVersion: 2,
      migrate: ({ version, data }) => {
        if (version !== 1 || !Array.isArray(data)) throw new Error('unexpected legacy backup');
        return { notes: data.filter((item): item is string => typeof item === 'string') };
      },
      validate: notesSchema.validate,
      counts: notesSchema.counts,
    };
    const preview = await previewBackup(legacy.value, schema);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.data).toEqual({ notes: ['from-v1'] });
    expect(preview.value.preview.counts).toEqual({ notes: 1 });
  });

  it('rejects malformed, unsupported, and checksum-mismatched backups before apply', async () => {
    const db = memory();
    const attempt = (raw: unknown) =>
      importBackup({
        raw,
        mode: 'replace',
        schema: notesSchema,
        snapshot: db.snapshot,
        apply: db.apply,
        restore: db.restore,
      });
    expect(await attempt('not json')).toMatchObject({
      ok: false,
      reason: 'validation',
      detail: 'Malformed backup.',
    });
    expect(await attempt({ format: 'other' })).toMatchObject({ ok: false, reason: 'validation' });

    const exported = await exportBackup({ appId: 'notes', data: { notes: ['a'] }, exportedAt });
    if (!exported.ok) throw new Error('export failed');
    const future = await exportBackup({
      appId: 'notes',
      data: { notes: ['a'] },
      exportedAt,
      version: 9,
    });
    if (!future.ok) throw new Error('export failed');
    expect(await attempt(future.value)).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(await attempt({ ...exported.value, data: { notes: ['tampered'] } })).toMatchObject({
      ok: false,
      reason: 'corrupt',
    });
    expect(await attempt({ ...exported.value, extra: true })).toMatchObject({
      ok: false,
      reason: 'validation',
    });
    expect(db.calls.apply).toBe(0);
    expect(db.store.notes).toEqual(['keep']);
  });

  it('rejects an oversized backup and refuses a missing import choice', async () => {
    const db = memory();
    const oversized = await exportBackup({
      appId: 'notes',
      data: { notes: ['x'.repeat(200)] },
      exportedAt,
      maxBytes: 80,
    });
    expect(oversized).toMatchObject({ ok: false, reason: 'oversized' });

    const exported = await exportBackup({ appId: 'notes', data: { notes: ['a'] }, exportedAt });
    if (!exported.ok) throw new Error('export failed');
    const padded = `${JSON.stringify(exported.value)}${' '.repeat(40)}`;
    const tooBig = await importBackup({
      raw: padded,
      mode: 'replace',
      schema: notesSchema,
      maxBytes: padded.length - 10,
      snapshot: db.snapshot,
      apply: db.apply,
      restore: db.restore,
    });
    expect(tooBig).toMatchObject({ ok: false, reason: 'oversized' });
    const choice = await importBackup({
      raw: exported.value,
      mode: 'append' as ImportMode,
      schema: notesSchema,
      snapshot: db.snapshot,
      apply: db.apply,
      restore: db.restore,
    });
    expect(choice).toMatchObject({
      ok: false,
      detail: 'Choose merge or replace before import.',
    });
    expect(db.calls.apply).toBe(0);
  });

  it('cancels before writing and rolls a cancelled apply back', async () => {
    const db = memory();
    const exported = await exportBackup({ appId: 'notes', data: { notes: ['next'] }, exportedAt });
    if (!exported.ok) throw new Error('export failed');
    const early = new AbortController();
    early.abort();
    expect(
      await importBackup({
        raw: exported.value,
        mode: 'replace',
        schema: notesSchema,
        signal: early.signal,
        snapshot: db.snapshot,
        apply: db.apply,
        restore: db.restore,
      }),
    ).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(db.calls.snapshot).toBe(0);

    const during = new AbortController();
    const cancelled = await importBackup({
      raw: exported.value,
      mode: 'replace',
      schema: notesSchema,
      signal: during.signal,
      snapshot: db.snapshot,
      apply: () => {
        db.store.notes.push('partial');
        during.abort();
        throw new DOMException('stopped', 'AbortError');
      },
      restore: db.restore,
    });
    expect(cancelled).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(db.store.notes).toEqual(['keep']);
    expect(db.calls.restore).toBe(1);
  });

  it('restores the snapshot when a write fails, and reports a failed rollback', async () => {
    const db = memory();
    const exported = await exportBackup({ appId: 'notes', data: { notes: ['next'] }, exportedAt });
    if (!exported.ok) throw new Error('export failed');
    const failed = await importBackup({
      raw: exported.value,
      mode: 'replace',
      schema: notesSchema,
      snapshot: db.snapshot,
      apply: () => {
        db.store.notes.push('partial');
        throw new Error('disk full');
      },
      restore: db.restore,
    });
    expect(failed).toMatchObject({ ok: false, reason: 'aborted' });
    expect(failed.ok ? '' : failed.detail).toContain('restored');
    expect(db.store.notes).toEqual(['keep']);

    const quota = await importBackup({
      raw: exported.value,
      mode: 'replace',
      schema: notesSchema,
      snapshot: db.snapshot,
      apply: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      restore: db.restore,
    });
    expect(quota).toMatchObject({ ok: false, reason: 'quota' });
    expect(db.store.notes).toEqual(['keep']);

    db.store.notes.push('partial');
    const broken = await importBackup({
      raw: exported.value,
      mode: 'replace',
      schema: notesSchema,
      snapshot: () => ({ notes: ['original'] }),
      apply: () => {
        db.store.notes = ['changed'];
        throw new Error('disk full');
      },
      restore: () => {
        throw new Error('restore failed');
      },
    });
    expect(broken).toMatchObject({ ok: false, reason: 'rollback' });
    expect(broken.ok ? '' : broken.detail).toContain('may be partial');
    expect(db.store.notes).toEqual(['changed']);
  });

  it('round-trips Date values as ISO strings and keeps the checksum', async () => {
    const source = {
      when: new Date('2026-01-01T00:00:00.000Z'),
      notes: ['a'],
    };
    const exported = await exportBackup({ appId: 'notes', data: source, exportedAt });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    source.notes.push('mutated');
    expect(exported.value.data).toEqual({
      when: '2026-01-01T00:00:00.000Z',
      notes: ['a'],
    });

    const schema: BackupSchema<{ when: string; notes: string[] }> = {
      supportedVersions: [1],
      validate: (value): value is { when: string; notes: string[] } =>
        !!value &&
        typeof value === 'object' &&
        typeof (value as { when?: unknown }).when === 'string' &&
        Array.isArray((value as { notes?: unknown }).notes) &&
        (value as { notes: unknown[] }).notes.every((note) => typeof note === 'string'),
      counts: (data) => ({ notes: data.notes.length }),
    };
    const preview = await previewBackup(JSON.stringify(exported.value), schema);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.data).toEqual({
      when: '2026-01-01T00:00:00.000Z',
      notes: ['a'],
    });

    const db = { notes: ['keep'] };
    const imported = await importBackup({
      raw: JSON.stringify(exported.value),
      mode: 'replace',
      schema,
      snapshot: () => ({ notes: [...db.notes] }),
      apply: (data) => {
        db.notes = [...data.notes];
      },
      restore: (snapshot) => {
        db.notes = [...snapshot.notes];
      },
    });
    expect(imported.ok).toBe(true);
    expect(db.notes).toEqual(['a']);
  });

  it('returns a validation failure for cyclic data', async () => {
    const data: { self?: unknown } = {};
    data.self = data;
    await expect(exportBackup({ appId: 'notes', data, exportedAt })).resolves.toMatchObject({
      ok: false,
      reason: 'validation',
      detail: 'Backup data is not JSON.',
    });
  });

  it('returns a validation failure for deeply nested data', async () => {
    let shallow: unknown = { leaf: true };
    for (let i = 0; i < 100; i += 1) shallow = { nested: shallow };
    const withinBound = await exportBackup({ appId: 'notes', data: shallow, exportedAt });
    expect(withinBound.ok).toBe(true);

    let deep: unknown = { leaf: true };
    for (let i = 0; i < 2000; i += 1) deep = { nested: deep };
    await expect(exportBackup({ appId: 'notes', data: deep, exportedAt })).resolves.toMatchObject({
      ok: false,
      reason: 'validation',
      detail: 'Backup data is not JSON.',
    });

    let nested = '{"leaf":true}';
    for (let i = 0; i < 2000; i += 1) nested = `{"nested":${nested}}`;
    const raw = `{"format":"fas-backup","version":1,"exportedAt":"${exportedAt}","appId":"notes","data":${nested},"checksum":"${'ab'.repeat(32)}"}`;
    const db = memory();
    const imported = await importBackup({
      raw,
      mode: 'replace',
      schema: notesSchema,
      snapshot: db.snapshot,
      apply: db.apply,
      restore: db.restore,
    });
    expect(imported.ok).toBe(false);
    expect(db.calls.apply).toBe(0);
  });

  it('registers the backup capability without erasing saved preferences', () => {
    const name = `notes${Date.now()}`;
    expect(setPreference(name, 'draft', { text: 'keep' }).ok).toBe(true);
    const first = registerBackupCapability();
    const second = registerBackupCapability();
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(getPreference(name, 'draft')).toEqual({ ok: true, value: { text: 'keep' } });
  });
});

describe('backup file transfer', () => {
  it('shares a file when the browser can, and does not leave an object URL', async () => {
    const exported = await exportBackup({ appId: 'notes', data: { notes: ['a'] }, exportedAt });
    if (!exported.ok) throw new Error('export failed');
    const shared: ShareData[] = [];
    const createObjectURL = vi.fn();
    const result = await shareOrDownloadBackup({
      envelope: exported.value,
      canShare: () => true,
      share: async (data) => {
        shared.push(data);
      },
      createObjectURL,
    });
    expect(result).toMatchObject({ ok: true, value: { method: 'share' } });
    expect(shared[0]?.files?.[0]?.name).toContain('fas-backup-notes-2026-11-04.json');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('falls back to a download and revokes the object URL', async () => {
    const exported = await exportBackup({ appId: 'notes', data: { notes: ['a'] }, exportedAt });
    if (!exported.ok) throw new Error('export failed');
    const revoked: string[] = [];
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click');
    const original = Document.prototype.createElement;
    const create = vi.spyOn(document, 'createElement');
    create.mockImplementation((tag: string) => {
      if (tag === 'a') return anchor;
      return original.call(document, tag);
    });
    const result = await shareOrDownloadBackup({
      envelope: exported.value,
      canShare: () => false,
      createObjectURL: () => 'blob:backup',
      revokeObjectURL: (url) => revoked.push(url),
      document,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.method).toBe('download');
    expect(click).toHaveBeenCalled();
    expect(anchor.download).toBe('fas-backup-notes-2026-11-04.json');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoked).toEqual(['blob:backup']);
    result.value.release();
    expect(revoked).toEqual(['blob:backup']);
    create.mockRestore();
  });

  it('returns JSON text when share and download are unavailable, and treats share dismiss as cancel', async () => {
    const exported = await exportBackup({ appId: 'notes', data: { notes: ['a'] }, exportedAt });
    if (!exported.ok) throw new Error('export failed');
    const text = await shareOrDownloadBackup({
      envelope: exported.value,
      canShare: () => false,
      document: null,
    });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.value.method).toBe('text');
    expect(text.value.text).toContain('"format":"fas-backup"');

    const dismissed = await shareOrDownloadBackup({
      envelope: exported.value,
      canShare: () => true,
      share: async () => {
        throw new DOMException('dismissed', 'AbortError');
      },
      createObjectURL: () => {
        throw new Error('download should not start');
      },
    });
    expect(dismissed).toMatchObject({ ok: false, reason: 'cancelled' });
  });
});

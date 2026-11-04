// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FileMetadata,
  getFile,
  getFileMetadata,
  listFiles,
  openFileStore,
  putFile,
} from './file-store.js';

const namespaces: string[] = [];

function meta(revision: number, id = 'note'): FileMetadata {
  return {
    id,
    name: 'Note',
    contentType: 'text/plain',
    byteLength: 0,
    revision,
    updatedAt: revision,
  };
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

afterEach(async () => {
  for (const name of namespaces.splice(0)) await deleteDB(`fas:${name}:files`);
});

async function store() {
  const namespace = `files${namespaces.length}`;
  namespaces.push(namespace);
  const opened = await openFileStore({ namespace });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error('open');
  return opened.value;
}

describe('file metadata and payload', () => {
  it('stores bytes apart from metadata and lists metadata only', async () => {
    const files = await store();
    const payload = text('a'.repeat(200_000));
    const saved = await putFile(files, { metadata: meta(1), payload });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.byteLength).toBe(payload.byteLength);
    expect(JSON.stringify(saved.value)).not.toContain('a'.repeat(100));

    const listed = await listFiles(files);
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(JSON.stringify(listed.value[0])).not.toContain('a'.repeat(100));

    const metadata = await getFileMetadata<FileMetadata>(files, 'note');
    expect(metadata).toEqual({ ok: true, value: { ...meta(1), byteLength: payload.byteLength } });

    const full = await getFile(files, 'note');
    expect(full.ok).toBe(true);
    if (!full.ok || !full.value) return;
    expect(full.value.payload.byteLength).toBe(payload.byteLength);
    files.close();
  });

  it('keeps the stored file when the caller does not supply a conflict policy', async () => {
    const files = await store();
    expect(await putFile(files, { metadata: meta(1), payload: text('one') })).toMatchObject({
      ok: true,
    });
    const conflict = await putFile(files, { metadata: meta(2), payload: text('two') });
    expect(conflict).toMatchObject({ ok: false, reason: 'conflict' });
    const full = await getFile(files, 'note');
    expect(full.ok).toBe(true);
    if (!full.ok || !full.value) return;
    expect(new TextDecoder().decode(full.value.payload)).toBe('one');
    expect(full.value.metadata.revision).toBe(1);
    files.close();
  });

  it('commits the app conflict policy only when it returns a record', async () => {
    const files = await store();
    await putFile(files, { metadata: meta(1), payload: text('one') });
    const rejected = await putFile(files, {
      metadata: meta(1),
      payload: text('stale'),
      resolveConflict: () => null,
    });
    expect(rejected).toMatchObject({ ok: false, reason: 'conflict' });
    const saved = await putFile(files, {
      metadata: meta(2),
      payload: text('two'),
      resolveConflict(local, incoming) {
        return incoming.metadata.revision > local.metadata.revision ? incoming : null;
      },
    });
    expect(saved.ok).toBe(true);
    const full = await getFile(files, 'note');
    if (!full.ok || !full.value) throw new Error('missing');
    expect(new TextDecoder().decode(full.value.payload)).toBe('two');
    expect(full.value.metadata.revision).toBe(2);
    files.close();
  });

  it('reports corrupt when the payload is missing and does not delete metadata', async () => {
    const files = await store();
    const tx = files.database.transaction('metadata', 'readwrite');
    await tx.store.put(meta(1), 'note');
    await tx.done;
    const full = await getFile(files, 'note');
    expect(full).toMatchObject({ ok: false, reason: 'corrupt' });
    const metadata = await getFileMetadata(files, 'note');
    expect(metadata.ok).toBe(true);
    if (!metadata.ok) return;
    expect(metadata.value).toMatchObject({ id: 'note', revision: 1 });
    files.close();
  });
});

describe.each(['explicit', 'versionchange'] as const)('%s close', (kind) => {
  it('contains all file transaction starts and preserves metadata and bytes', async () => {
    const files = await store();
    await putFile(files, { metadata: meta(1), payload: text('kept') });
    const before = await getFile(files, 'note');
    if (kind === 'explicit') files.close();
    const next = await openFileStore({
      namespace: files.namespace,
      version: kind === 'explicit' ? 1 : 2,
    });
    if (!next.ok) throw new Error('reopen');
    try {
      for (const operation of [
        () => getFile(files, 'note'),
        () => getFileMetadata(files, 'note'),
        () => listFiles(files),
        () =>
          putFile(files, {
            metadata: meta(2),
            payload: text('lost'),
            resolveConflict: (_, incoming) => incoming,
          }),
      ])
        await expect(operation()).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
      expect(await getFile(next.value, 'note')).toEqual(before);
    } finally {
      next.value.close();
    }
  });
});

it.each(['copy', 'mutate'] as const)(
  'rejects cross-ID conflict resolution (%s) preserving both files',
  async (kind) => {
    const files = await store();
    try {
      await putFile(files, { metadata: meta(1, 'a'), payload: text('one') });
      await putFile(files, { metadata: meta(2, 'b'), payload: text('two') });
      const beforeA = await getFile(files, 'a');
      const beforeB = await getFile(files, 'b');
      const metadata = meta(3, 'a');
      await expect(
        putFile(files, {
          metadata,
          payload: text('three'),
          resolveConflict: (_, incoming) => {
            if (kind === 'mutate') {
              metadata.id = 'b';
              incoming.metadata.id = 'b';
              return incoming;
            }
            return { ...incoming, metadata: { ...incoming.metadata, id: 'b' } };
          },
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'validation' });
      expect(await getFile(files, 'a')).toEqual(beforeA);
      expect(await getFile(files, 'b')).toEqual(beforeB);
      await expect(
        putFile(files, {
          metadata: meta(4, 'a'),
          payload: text('four'),
          resolveConflict: () => {
            throw new Error('policy failed');
          },
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'validation', detail: 'policy failed' });
      expect(await getFile(files, 'a')).toEqual(beforeA);
    } finally {
      files.close();
    }
  },
);

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

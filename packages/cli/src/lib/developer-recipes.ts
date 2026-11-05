/** Worker-safe examples shared by capability guides and the MCP reference.
 * scripts/developer-recipes.test.ts typechecks these exact strings against SDK source.
 */
export const FORM_EXAMPLE = `import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Modal } from '@freeappstore/sdk/ui';

export type Item = { id: string; name: string };
type EditorProps = { item: Item; onSave(item: Item): Promise<void> };

export function EditItemButton({ item, onSave }: EditorProps) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="min-h-11 rounded border border-line px-3 py-2"
      onClick={() => setOpen(true)}>Edit {item.name}</button>
    {open && <ItemForm key={item.id} item={item} onSave={onSave} onClose={() => setOpen(false)} />}
  </>;
}

// Mount per editing session: reopening starts with the current item, not a stale draft.
function ItemForm({ item, onSave, onClose }: EditorProps & { onClose(): void }) {
  const nameId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [name, setName] = useState(item.name);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => { if (error && !pending) input.current?.focus(); }, [error, pending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    const nextName = name.trim();
    if (!nextName) { setInvalid(true); setError('Enter a name.'); return; }
    setInvalid(false);
    setError('');
    saving.current = true;
    setPending(true);
    try {
      // The app owns persistence. Throw on a failed SDK result; do not discard it.
      await onSave({ ...item, name: nextName });
      onClose();
    } catch {
      setError('Could not save. Your changes are still here.');
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return <Modal open title="Edit item" onClose={() => { if (!saving.current) onClose(); }}>
    <form noValidate onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <label htmlFor={nameId} className="font-semibold">Name</label>
      <input ref={input} id={nameId} data-autofocus value={name} disabled={pending}
        aria-invalid={invalid} aria-describedby={error ? errorId : undefined}
        onChange={event => { setName(event.target.value); setInvalid(false); setError(''); }}
        className="min-h-11 w-full min-w-0 rounded border border-line bg-paper p-3 text-ink" />
      {error && <p id={errorId} role="alert">{error}</p>}
      {pending && <p role="status">Saving…</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={pending} onClick={onClose}
          className="min-h-11 rounded border border-line px-3 py-2">Cancel</button>
        <button type="submit" disabled={pending}
          className="min-h-11 rounded bg-accent px-3 py-2 text-white">Save</button>
      </div>
    </form>
  </Modal>;
}
`;

export const PERSISTENCE_EXAMPLE = `import { openStore, getRecord, putRecord } from '@freeappstore/sdk/persist';

type Draft = { text: string };
const isDraft = (value: unknown): value is Draft =>
  typeof value === 'object' && value !== null &&
  'text' in value && typeof value.text === 'string';

export async function loadDraft() {
  const opened = await openStore({ namespace: 'notes', version: 1 });
  if (!opened.ok) return opened;
  try {
    // undefined means no record yet. A failed result is not an empty database.
    return await getRecord(opened.value, 'draft', isDraft);
  } finally {
    opened.value.close();
  }
}

export async function saveDraft(draft: Draft) {
  const opened = await openStore({ namespace: 'notes', version: 1 });
  if (!opened.ok) return opened;
  try {
    // Show "Saved" only if the returned result.ok is true.
    return await putRecord(opened.value, 'draft', draft, isDraft);
  } finally {
    opened.value.close();
  }
}
`;

export const BACKUP_EXAMPLE = `import {
  exportBackup, previewBackup, importBackup, shareOrDownloadBackup,
  type BackupSchema, type ImportMode,
} from '@freeappstore/sdk/backup';

type Notes = { notes: string[] };
const schema: BackupSchema<Notes> = {
  supportedVersions: [1],
  validate: (value: unknown): value is Notes =>
    typeof value === 'object' && value !== null && 'notes' in value &&
    Array.isArray(value.notes) && value.notes.every(note => typeof note === 'string'),
  counts: data => ({ notes: data.notes.length }),
};

export async function exportNotes(data: Notes) {
  const envelope = await exportBackup({ appId: 'notes', data });
  if (!envelope.ok) return envelope;
  // Handle failures and method === 'text' in the UI; expose its copyable text.
  // The returned download handle also has release() for explicit URL cleanup.
  return shareOrDownloadBackup({ envelope: envelope.value });
}

export function inspectNotes(raw: unknown) {
  // Check result.ok, then show result.value.preview.counts before asking for mode.
  return previewBackup(raw, schema);
}

export function restoreNotes(
  raw: unknown,
  mode: ImportMode, // User must choose. Never default to replacement.
  storage: {
    read(): Promise<Notes>;
    write(data: Notes): Promise<void>; // Must throw if the underlying write fails.
  },
) {
  return importBackup({
    raw, mode, schema,
    snapshot: () => storage.read(),
    apply: async (incoming, selectedMode) => {
      const next = selectedMode === 'replace' ? incoming : {
        notes: [...new Set([...(await storage.read()).notes, ...incoming.notes])],
      };
      await storage.write(next);
    },
    restore: snapshot => storage.write(snapshot),
  });
  // Check result.ok. reason === 'rollback' means stored data may be partial.
}
`;

/** Worker-safe examples shared by capability guides and the MCP reference.
 * scripts/developer-recipes.test.ts typechecks these exact strings against SDK source.
 */
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

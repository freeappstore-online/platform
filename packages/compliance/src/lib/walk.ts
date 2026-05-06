import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.cache',
  '.wrangler',
  '.turbo',
]);

/**
 * Recursive file iteration that skips noise directories. Used by every
 * check that needs to scan source files.
 */
export async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing dir is not an error here — caller decides
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

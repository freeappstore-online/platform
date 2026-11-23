#!/usr/bin/env node
/**
 * CI guard (#641): no in-flight promise shared across Worker requests.
 *
 * Workers drop a promise's settlement in any request other than the one that
 * created it, so a module-level "dedup" promise makes the second awaiter throw
 * once the first request ends: error 1101 on about half of app roots (#639).
 * Plain-data caches with a TTL are fine; promises are not.
 *
 * Flags, in Worker sources, a module-scope:
 *   - `let`/`var` whose declaration mentions `Promise`;
 *   - `let`/`var` that the file assigns with `??=`;
 *   - Map/WeakMap whose type holds a `Promise`.
 * A justified case carries `// worker-state-ok: <reason>` on the line or the line above.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_SOURCES = [
  'packages/backend/src',
  'packages/kb-host/src',
  'workers/admin/src',
  'workers/agent/src',
  'workers/host/src',
  'workers/mcp/src',
];

const ALLOW = /\/\/\s*worker-state-ok:\s*\S/;
const TOP_LEVEL_BINDING = /^(?:export\s+)?(let|var)\s+([A-Za-z_$][\w$]*)/;
const PROMISE_MAP = /^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\b.*\b(?:Map|WeakMap)\s*<.*\bPromise\b/;

/** Violations in one file's source, as `line: reason` strings. */
export function findSharedPromises(source) {
  const lines = source.split('\n');
  const found = [];
  const allowed = (i) => ALLOW.test(lines[i]) || (i > 0 && ALLOW.test(lines[i - 1]));
  lines.forEach((line, i) => {
    if (allowed(i)) return;
    const binding = TOP_LEVEL_BINDING.exec(line);
    if (binding) {
      const name = binding[2];
      if (/\bPromise\b/.test(line)) {
        found.push(`${i + 1}: module-scope ${binding[1]} ${name} holds a Promise`);
      } else if (new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\?\\?=`).test(source)) {
        found.push(`${i + 1}: module-scope ${binding[1]} ${name} is assigned with ??=`);
      }
    } else if (PROMISE_MAP.test(line)) {
      found.push(`${i + 1}: module-scope Map of Promises`);
    }
  });
  return found;
}

function* sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'test') yield* sourceFiles(path);
    } else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      yield path;
    }
  }
}

export function checkRepo(root) {
  const failures = [];
  for (const dir of WORKER_SOURCES) {
    for (const file of sourceFiles(join(root, dir))) {
      for (const hit of findSharedPromises(readFileSync(file, 'utf8'))) {
        failures.push(`${relative(root, file)}:${hit}`);
      }
    }
  }
  return failures;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const failures = checkRepo(fileURLToPath(new URL('..', import.meta.url)));
  for (const failure of failures) console.error(failure);
  if (failures.length) {
    console.error(
      '\nA promise shared across Worker requests throws 1101 in the second request (#639). ' +
        'Await per request and cache only plain data, or mark a justified case with `// worker-state-ok: <reason>`.',
    );
    process.exit(1);
  }
  console.log('worker-state: no module-scope shared promises');
}

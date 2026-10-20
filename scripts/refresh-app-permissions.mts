/**
 * Refresh each listed app's browser permissions in the storefront registry
 * (#285). For every app, shallow-clone its public repo, read the permissions
 * it declares in web/public/manifest.json (with reasons) and detect the ones
 * its source uses, and write the union to the registry entry's `permissions`.
 *
 * An empty list means the app asks for nothing. A repo that can't be read
 * keeps its previous value, so a transient GitHub failure never blanks a
 * listing.
 *
 *   npx tsx scripts/refresh-app-permissions.mts            # all apps
 *   npx tsx scripts/refresh-app-permissions.mts echoshift  # some apps
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fsFileSource } from '../packages/compliance/src/lib/file-source.js';
import {
  detectPermissions,
  isPermissionId,
  PERMISSION_IDS,
  readDeclaredPermissions,
} from '../packages/compliance/src/lib/permissions.js';

const run = promisify(execFile);
const REGISTRY = join(import.meta.dirname, '..', 'sites', 'storefront', 'registry.json');
const REPO_RE = /^freeappstore-online\/[A-Za-z0-9._-]+$/;
const CONCURRENCY = 8;

type Permission = string | { name: string; reason: string };
interface App {
  id: string;
  repo: string;
  permissions?: Permission[];
  microphone?: boolean;
}

async function scan(app: App, workDir: string): Promise<Permission[] | null> {
  if (!REPO_RE.test(app.repo)) return null;
  const dir = join(workDir, app.id);
  try {
    await run(
      'git',
      ['clone', '--quiet', '--depth', '1', `https://github.com/${app.repo}.git`, dir],
      {
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );
  } catch {
    return null;
  }
  try {
    const source = fsFileSource(dir);
    const detected = await detectPermissions(source);
    const declared = (await readDeclaredPermissions(source)) ?? [];
    const reasons = new Map(
      declared.filter((d) => d.reason).map((d) => [d.name, d.reason as string]),
    );
    const ids = new Set([
      ...declared.map((d) => d.name).filter(isPermissionId),
      ...detected.keys(),
    ]);
    return PERMISSION_IDS.filter((id) => ids.has(id)).map((id) =>
      reasons.has(id) ? { name: id, reason: reasons.get(id) as string } : id,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as { apps: App[] };
const only = new Set(process.argv.slice(2));
const apps = registry.apps.filter((a) => only.size === 0 || only.has(a.id));
const workDir = mkdtempSync(join(tmpdir(), 'fas-permissions-'));
const failed: string[] = [];
let changed = 0;

try {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < apps.length) {
        const app = apps[next++] as App;
        const permissions = await scan(app, workDir);
        if (permissions === null) {
          failed.push(app.id);
          continue;
        }
        if (JSON.stringify(permissions) !== JSON.stringify(app.permissions)) changed++;
        app.permissions = permissions;
        // Replaced by permissions (the #272 banner that read it is retired).
        delete app.microphone;
      }
    }),
  );
} finally {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
}

// Same format admin's publish writes (no trailing newline), so diffs stay minimal.
writeFileSync(REGISTRY, JSON.stringify(registry, null, 2));
const asking = apps.filter((a) => a.permissions?.length);
console.log(
  `scanned ${apps.length - failed.length}/${apps.length} apps, ${changed} changed, ${asking.length} ask for permissions`,
);
for (const a of asking) {
  console.log(
    `  ${a.id}: ${a.permissions?.map((p) => (typeof p === 'string' ? p : p.name)).join(', ')}`,
  );
}
if (failed.length) console.log(`could not read ${failed.length}: ${failed.join(', ')}`);

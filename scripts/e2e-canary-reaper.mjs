// Reaps e2e canaries a crashed prod-platform-e2e run left behind (#551).
//
// A run that dies between publish and unpublish leaks an `e2e-canary-*` repo,
// route and registry entry, and nothing else ever removes them. Every run
// starts by unpublishing (deleteRepo: true) any canary older than an hour, the
// same owner path the run itself uses for its own cleanup. The age floor keeps
// it away from a canary a concurrent run is still using.

export const CANARY_RE = /^e2e-canary-[a-z0-9]{4,20}$/;
export const CANARY_MAX_AGE_MS = 60 * 60 * 1000;

/** Repos (`{ name, created_at }`) that are canaries older than `maxAgeMs`. */
export function leakedCanaries(repos, now = Date.now(), maxAgeMs = CANARY_MAX_AGE_MS) {
  return repos.filter(
    (repo) => CANARY_RE.test(repo.name) && now - Date.parse(repo.created_at) > maxAgeMs,
  );
}

/**
 * Unpublish every leaked canary. `unpublish(id)` resolves to 'removed' or
 * 'gone' and rejects on failure; one failure never stops the others.
 */
export async function reapLeakedCanaries({
  listRepos,
  unpublish,
  now = Date.now(),
  log = console.log,
}) {
  const reaped = [];
  const failed = [];
  for (const repo of leakedCanaries(await listRepos(), now)) {
    try {
      await unpublish(repo.name);
      reaped.push(repo.name);
      log(`  reaped leaked canary ${repo.name}`);
    } catch (e) {
      failed.push({ id: repo.name, reason: e instanceof Error ? e.message : String(e) });
      log(`  could not reap ${repo.name}: ${failed.at(-1).reason}`);
    }
  }
  return { reaped, failed };
}

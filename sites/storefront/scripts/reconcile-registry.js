#!/usr/bin/env node
/**
 * Reconciles registry.json `creatorGithub` against D1 (the source of truth).
 *
 * The storefront stays fully static — this does NOT make the store query D1 at
 * runtime. It pulls the public creator feed (GET /v1/apps/creators, backed by
 * the D1 `apps` table) and rewrites the static registry.json so its attribution
 * can't drift from D1 (as it did for typeflow/snowman). Presentation fields
 * (icon, description, appUrl, …) are untouched — only creatorGithub is synced,
 * and only for apps that exist in both registry and D1.
 *
 * Usage:
 *   node scripts/reconcile-registry.js          # apply + write registry.json
 *   node scripts/reconcile-registry.js --check  # report only, exit 1 if drift
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'registry.json');
const API = process.env.FAS_API || 'https://api.freeappstore.online';
const CHECK = process.argv.includes('--check');

async function main() {
  let creators;
  try {
    const res = await fetch(`${API}/v1/apps/creators`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      console.error(`reconcile: creator feed failed (HTTP ${res.status})`);
      process.exit(2);
    }
    ({ creators } = await res.json());
  } catch (err) {
    console.error('reconcile: could not fetch creator feed:', err.message);
    process.exit(2);
  }
  if (!creators || typeof creators !== 'object') {
    console.error('reconcile: unexpected creator feed payload');
    process.exit(2);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const changes = [];
  for (const app of registry.apps) {
    const truth = creators[app.id];
    if (truth && app.creatorGithub !== truth) {
      changes.push({ id: app.id, from: app.creatorGithub || '(none)', to: truth });
      if (!CHECK) app.creatorGithub = truth;
    }
  }

  if (changes.length === 0) {
    console.log('reconcile: registry.json creator attribution is in sync with D1.');
    return;
  }

  for (const c of changes) console.log(`  ${c.id}: ${c.from} -> ${c.to}`);

  if (CHECK) {
    console.error(
      `reconcile: ${changes.length} app(s) drifted from D1. ` +
        "Run 'node scripts/reconcile-registry.js' and commit registry.json.",
    );
    process.exit(1);
  }

  fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`reconcile: synced ${changes.length} creatorGithub value(s) from D1.`);
}

main().catch((err) => {
  console.error('reconcile: unexpected error:', err);
  process.exit(2);
});

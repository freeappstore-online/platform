#!/usr/bin/env node
/**
 * Fetches VCQA scores from the quality API for all apps in registry.json.
 * Outputs: dist/quality/scores.json
 *
 * Run before build.js to embed quality badges in storefront cards and detail pages.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_QUALITY = path.join(ROOT, 'dist', 'quality');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8'));
const API = 'https://api.freeappstore.online/v1/apps';

async function main() {
  fs.mkdirSync(DIST_QUALITY, { recursive: true });
  const scores = {};
  let fetched = 0;
  let failed = 0;

  await Promise.all(
    REGISTRY.apps.map(async (app) => {
      try {
        const res = await fetch(`${API}/${app.id}/quality`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) { failed++; return; }
        const data = await res.json();
        if (data.score !== undefined && data.grade) {
          scores[app.id] = { score: data.score, grade: data.grade };
          fetched++;
        }
      } catch {
        failed++;
      }
    })
  );

  fs.writeFileSync(path.join(DIST_QUALITY, 'scores.json'), JSON.stringify(scores, null, 2));
  console.log(`Fetched ${fetched} quality scores (${failed} unavailable)`);
}

main().catch((err) => { console.error(err); process.exit(1); });

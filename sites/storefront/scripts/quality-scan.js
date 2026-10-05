#!/usr/bin/env node
/**
 * Runs @vibecodeqa/cli on every app in registry.json.
 * Outputs: dist/quality/<app-id>/index.html (report) + dist/quality/scores.json (summary)
 *
 * Usage: node scripts/quality-scan.js
 * Requires: git, npx, GITHUB_TOKEN or gh CLI auth
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_QUALITY = path.join(ROOT, 'dist', 'quality');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8'));
const TMP = path.join(require('os').tmpdir(), 'fas-quality-scan');

// Ensure output dirs exist
fs.mkdirSync(DIST_QUALITY, { recursive: true });

const scores = {};

for (const app of REGISTRY.apps) {
  const appDir = path.join(TMP, app.id);
  const reportDir = path.join(DIST_QUALITY, app.id);
  fs.mkdirSync(reportDir, { recursive: true });

  console.log(`\n--- ${app.id} (${app.repo}) ---`);

  try {
    // Clone (shallow) or pull
    if (fs.existsSync(path.join(appDir, '.git'))) {
      execSync('git pull --ff-only', { cwd: appDir, stdio: 'pipe' });
    } else {
      fs.mkdirSync(appDir, { recursive: true });
      execSync(`git clone --depth 1 https://github.com/${app.repo}.git ${appDir}`, { stdio: 'pipe' });
    }

    // Run vibecodeqa CLI (generates both HTML + JSON in .vibe-check/)
    execSync('npx --yes @vibecodeqa/cli 2>/dev/null || true', {
      cwd: appDir,
      timeout: 60000,
      stdio: 'pipe',
    });

    // Read JSON report
    const jsonPath = path.join(appDir, '.vibe-check', 'report.json');
    const htmlPath = path.join(appDir, '.vibe-check', 'report', 'index.html');

    if (fs.existsSync(jsonPath)) {
      const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      scores[app.id] = { score: report.score, grade: report.grade };

      // Copy JSON
      fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));

      // Copy all HTML report pages
      const htmlDir = path.join(appDir, '.vibe-check', 'report');
      if (fs.existsSync(htmlDir)) {
        for (const file of fs.readdirSync(htmlDir)) {
          fs.copyFileSync(path.join(htmlDir, file), path.join(reportDir, file));
        }
        console.log(`  Score: ${report.score} (${report.grade}) — HTML + JSON saved`);
      } else {
        console.log(`  Score: ${report.score} (${report.grade}) — JSON only`);
      }
    } else {
      console.log(`  WARN: no report.json generated`);
      scores[app.id] = { score: null, grade: null, error: 'no report generated' };
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message?.slice(0, 80)}`);
    scores[app.id] = { score: null, grade: null, error: err.message?.slice(0, 100) };
  }
}

// Write summary
fs.writeFileSync(path.join(DIST_QUALITY, 'scores.json'), JSON.stringify(scores, null, 2));
console.log(`\n\nDone. ${Object.keys(scores).length} apps scanned.`);
console.log(`Scores: ${JSON.stringify(scores, null, 2)}`);

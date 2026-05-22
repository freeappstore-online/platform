# VCQA Integration Spec for FreeAppStore

Requirements for integrating vibecodeqa.online into the FreeAppStore platform (and any other platform that wants to embed code health scores).

**From:** FreeAppStore platform team
**To:** VibeCodeQA team
**Date:** 2026-05-23

## Context

FreeAppStore hosts 30+ web apps. Each app is a GitHub repo in the `freeappstore-online` org. We want to show VCQA code health scores in two places:

1. **Creator Console** (`console.freeappstore.online`) -- each app's detail page shows its VCQA score, grade, issue count, and trend
2. **Store listings** (`freeappstore.online/apps/{id}`) -- a badge showing the grade

We do NOT want to run `@vibecodeqa/cli` in our CI pipeline because:
- It adds install + scan time to every deploy (~5-10s for the CLI, more with deps)
- Reports go stale between deploys
- HTML reports don't match our design system
- We'd need to host/serve the generated report files ourselves

## What we need from VCQA

### 1. Hosted Scan API

```
POST https://vibecodeqa.online/api/v1/scan
Content-Type: application/json

{
  "repo": "freeappstore-online/timer",
  "branch": "main"         // optional, defaults to default branch
}

Response:
{
  "id": "scan_abc123",
  "status": "queued"        // queued | running | completed | failed
}
```

And a results endpoint:

```
GET https://vibecodeqa.online/api/v1/scan/{scan_id}

Response (when completed):
{
  "id": "scan_abc123",
  "status": "completed",
  "repo": "freeappstore-online/timer",
  "branch": "main",
  "commit": "a1b2c3d",
  "timestamp": "2026-05-23T12:00:00Z",
  "score": 72,
  "grade": "C",
  "checks": [
    {
      "name": "structure",
      "score": 85,
      "grade": "B",
      "issues": 2,
      "details": { ... }    // same shape as report.json today
    }
  ],
  "issues_total": 14,
  "report_url": "https://vibecodeqa.online/reports/freeappstore-online/timer/latest"
}
```

**Auth:** API key in `Authorization: Bearer <key>` header. One key per platform integration (not per repo).

**Rate limit:** We'd scan ~30 repos. A daily cron is fine. Burst of 30 scans when triggered manually from the console.

### 2. Latest Report API (no scan trigger)

```
GET https://vibecodeqa.online/api/v1/repos/{org}/{repo}/latest

Response:
{
  "score": 72,
  "grade": "C",
  "issues_total": 14,
  "checks_passed": 15,
  "checks_total": 22,
  "timestamp": "2026-05-23T12:00:00Z",
  "commit": "a1b2c3d",
  "report_url": "https://vibecodeqa.online/reports/freeappstore-online/timer/latest"
}
```

This is what our console polls. No scan triggered. Just returns the most recent results.

**CORS:** Must allow `console.freeappstore.online` and `freeappstore.online` origins (or `*` if the data is non-sensitive).

### 3. Badge SVG

```
GET https://vibecodeqa.online/badge/{org}/{repo}.svg

Returns: SVG badge like shields.io format
Example: [vcqa | B 78/100] in green/yellow/red based on grade
```

We embed this in store listing pages:
```html
<img src="https://vibecodeqa.online/badge/freeappstore-online/timer.svg" alt="Code health" />
```

Cached with reasonable TTL (1 hour). Updates when a new scan completes.

### 4. GitHub Webhook (auto-scan on push)

A GitHub App or webhook endpoint that:
1. Listens for `push` events on `main` branch
2. Triggers a scan automatically
3. Stores the result so the Latest Report API returns fresh data

This means our console always shows up-to-date scores without us triggering scans.

**Setup:** We install the GitHub App on the `freeappstore-online` org. VCQA scans every repo on push. No per-repo config needed.

### 5. Embeddable Widget (nice to have)

```html
<script src="https://vibecodeqa.online/widget.js" data-repo="freeappstore-online/timer" data-theme="dark"></script>
```

Renders a small inline card with score, grade, trend arrow, and link to full report. Self-contained (no external CSS needed). Respects `data-theme` for light/dark.

We might not use this (we'd rather render natively from the JSON API), but other platforms integrating VCQA would benefit from a drop-in widget.

## What we build on our side

Once the API exists, we:

1. **Console "Code Health" section** in `AppDetail.tsx`:
   - Fetch `GET /api/v1/repos/{org}/{appId}/latest` on page load
   - Render score, grade, issue count using our own Badge/ProgressBar/Card components
   - Link to `report_url` for full details
   - "Rescan" button that calls `POST /api/v1/scan`
   - Trend indicator if historical data is available

2. **Store listing badge** in app detail pages:
   - `<img>` tag pointing to the badge SVG
   - Links to the hosted report

3. **Daily cron** (optional, in our backend Worker):
   - Scan all repos once per day via the API
   - Ensures data is fresh even if the GitHub webhook misses an event

## What we DON'T want

- **Don't make us run the CLI in CI.** The API should be the primary integration path.
- **Don't make us host report HTML.** VCQA should host the report at a stable URL.
- **Don't require per-repo configuration.** Org-level GitHub App install should cover all repos.
- **Don't require a paid plan for public repos.** The repos are MIT open source. Scanning public repos should be free (or included in a platform-level plan).

## Data shape compatibility

The `report.json` that the CLI currently produces is a good starting point for the API response. We'd need:
- Same check names and score structure
- `report_url` added (link to hosted report)
- `commit` SHA added (so we can show which commit was scanned)
- `timestamp` in ISO 8601

## Timeline

No rush. We'll build the console UI once the API is available. Happy to test a beta endpoint. The badge SVG is the fastest win (we can use it immediately in store listings with zero code on our side).

## Questions for the VCQA team

1. Is there an existing API we missed? The npm package README doesn't mention one.
2. What's the pricing model for API access? Per-scan, per-repo, per-org, flat?
3. Can the GitHub App be scoped to specific orgs (we have 5 orgs across the platform family)?
4. Is there a webhook for "scan completed" so we can update the console in real time instead of polling?
5. Any interest in co-marketing? FreeAppStore showing VCQA scores on every app listing is good exposure for both.

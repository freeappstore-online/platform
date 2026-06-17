import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runChecks } from '@freeappstore/compliance';
import { Command } from 'commander';
import prompts from 'prompts';
import { assertValidAppId } from '../lib/app-id.js';
import { readConfig, sessionDaysRemaining } from '../lib/config.js';
import { yellow } from '../lib/style.js';
import { renderCheckResults } from './check.js';

// Must match the dropdown options in
// freeappstore-online/submissions/.github/ISSUE_TEMPLATE/app-submission.yml
const CATEGORIES = [
  'Learning',
  'Strategy',
  'Discovery',
  'Brain Training',
  'Social',
  'Productivity',
  'Health & Fitness',
  'Finance',
  'News & Weather',
  'Utilities',
  'Other (specify in description)',
] as const;

const TYPES = [
  'Standalone (no backend, localStorage only)',
  'Connected (Firebase/Supabase backend, shared with Pro version)',
] as const;

export type Store = 'apps' | 'games';

interface SubmissionInput {
  name: string;
  category: (typeof CATEGORIES)[number];
  type: (typeof TYPES)[number];
  oneliner: string;
  description: string;
  repo: string | null;
  demo: string | null;
}

/** Per-store branding the publish flow needs to keep the two stores parallel. */
export const STORE_META = {
  apps: {
    label: 'FreeAppStore',
    domain: 'freeappstore.online',
    org: 'freeappstore-online',
  },
  games: {
    label: 'FreeGameStore',
    domain: 'freegamestore.online',
    org: 'freegamestore-online',
  },
} as const;

// Where to look when provisioning is down. Surfaced on hard failures so a
// blocked creator can see status instead of being quietly shunted to a form.
const STATUS_URL = 'https://api.freeappstore.online/status';

export const publishCommand = new Command('publish')
  .description(
    'Publish this app or game. Provisions repo + hosting + DNS automatically. If provisioning fails, it fails loudly with the reason — there is no manual submission fallback.',
  )
  .option(
    '--store <name>',
    'Target store: "apps" (FreeAppStore) or "games" (FreeGameStore). Defaults to "apps".',
    'apps',
  )
  .option(
    '--skip-checks',
    'Skip compliance checks (not recommended — provisioning may still reject the app).',
  )
  .option('--name <id>', 'App id (lowercase, used as subdomain). Skips the prompt.')
  .option(
    '--category <name>',
    'Category. Use exact label or its lowercased form (e.g. "utilities", "brain training"). Skips the prompt.',
  )
  .option('--type <kind>', 'App type: "standalone" or "connected". Skips the prompt.')
  .option('--oneliner <text>', 'One-line description shown on the storefront. Skips the prompt.')
  .option('--demo <url>', 'Optional demo URL. Skips the prompt.')
  .option(
    '-y, --yes',
    'Non-interactive: fail rather than prompt for any missing fields. Pair with --name/--category/--type/--oneliner.',
  )
  .action(
    async (opts: {
      store?: string;
      skipChecks?: boolean;
      name?: string;
      category?: string;
      type?: string;
      oneliner?: string;
      demo?: string;
      yes?: boolean;
    }) => {
      const store: Store = opts.store === 'games' ? 'games' : 'apps';
      if (opts.store && opts.store !== 'apps' && opts.store !== 'games') {
        process.stdout.write(`✗ --store must be "apps" or "games", got "${opts.store}"\n`);
        process.exit(1);
      }
      const meta = STORE_META[store];
      // Check auth BEFORE prompting — there's no point asking the user for
      // 5 fields just to bail at the end with an auth error.
      // We distinguish "never signed in" from "session expired": both are
      // fixed by `fas login`, but calling an expired session "not signed in"
      // reads as a permissions problem and sends people chasing access grants
      // that don't exist (publishing needs no special permission).
      {
        const config = await readConfig();
        const daysLeft = sessionDaysRemaining(config);
        if (!config.session?.token) {
          process.stdout.write(
            '\n⚠  Not signed in. Run `fas login` to get started.\n' +
              '   Any signed-in account can publish — there is no separate permission to request.\n',
          );
          process.exit(1);
        }
        if (daysLeft !== null && daysLeft <= 0) {
          process.stdout.write(
            '\n⚠  Your fas session has expired (sessions last 30 days).\n' +
              '   Run `fas login` to refresh it, then re-run `fas publish` — that is all you need.\n' +
              '   (No publishing permission is required; a fresh login fully restores access.)\n',
          );
          process.exit(1);
        }
        if (daysLeft !== null && daysLeft <= 3) {
          process.stdout.write(
            `\nℹ  Heads up: your fas session expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. ` +
              'Run `fas login` soon to avoid interruptions.\n',
          );
        }
      }

      // Run compliance checks BEFORE prompts so a doomed submission fails
      // fast. Hard fails block; warnings allow through. Bypass with
      // --skip-checks if you really need to (admin review will still
      // catch issues).
      if (!opts.skipChecks) {
        process.stdout.write('Running compliance checks...\n\n');
        const results = await runChecks(process.cwd());
        const { failed } = renderCheckResults(results);
        if (failed > 0) {
          process.stdout.write(
            '\n⚠  Fix the failures above before publishing, or pass --skip-checks to bypass.\n',
          );
          process.exit(1);
        }
        process.stdout.write('\n');
      }

      const repo = await detectGitRepo();
      const appName = await detectAppName();
      const description = await detectDescription();

      process.stdout.write(
        `\nLet's publish your ${store === 'games' ? 'game' : 'app'} to ${meta.label}.\n`,
      );

      // Resolve flag values up-front. Whatever's missing falls through to a
      // prompt — unless --yes is set, in which case missing values abort.
      const resolved = resolveFromFlags(opts);
      if (resolved.errors.length > 0) {
        for (const e of resolved.errors) process.stdout.write(`✗ ${e}\n`);
        process.exit(1);
      }

      // --yes: optional fields default rather than abort. demo is the only
      // optional field today; new optional fields go here too.
      if (opts.yes && resolved.values.demo === undefined) {
        resolved.values.demo = null;
      }

      const promptList = buildPromptList(resolved.values, { appName, description });
      const answers =
        promptList.length === 0
          ? {}
          : opts.yes
            ? (() => {
                const missing = promptList.map((p) => p.name).join(', ');
                process.stdout.write(`✗ --yes set but missing required field(s): ${missing}\n`);
                process.exit(1);
              })()
            : ((await prompts(promptList, {
                onCancel: () => {
                  process.stdout.write('\nCanceled.\n');
                  process.exit(1);
                },
              })) as Partial<SubmissionInput>);

      const merged: Partial<SubmissionInput> = { ...resolved.values, ...answers };
      const input: SubmissionInput = {
        name: merged.name!,
        category: merged.category!,
        type: merged.type!,
        oneliner: merged.oneliner!,
        // The backend's /v1/publish requires a non-empty description; the
        // storefront only shows the oneliner, so we reuse it here.
        description: merged.oneliner!,
        repo: repo ? `https://github.com/${repo}` : null,
        demo: merged.demo?.trim() ? merged.demo : null,
      };

      // Provision. There is no manual submission fallback: provisioning either
      // succeeds, or we fail loudly with the reason so it gets fixed (rather
      // than silently shunting the creator to a form they hate).
      const autoResult = await tryAutoProvision(input, store);
      if (autoResult.kind === 'success') {
        const noun = store === 'games' ? 'game' : 'app';
        const listingPath = store === 'games' ? 'games' : 'apps';

        // Ensure the deploy workflow exists locally so the first push
        // triggers an R2 deploy. Also upgrades legacy CF Pages workflows
        // to the current R2 template.
        const workflowResult = await ensureDeployWorkflow();

        process.stdout.write(`\n✓ Provisioned!\n`);
        process.stdout.write(`  Live at:  ${autoResult.appUrl}\n`);
        process.stdout.write(`  Repo:     ${autoResult.repoUrl}\n`);
        process.stdout.write(`  Listing:  https://${meta.domain}/${listingPath}/${input.name}\n\n`);
        if (workflowResult === 'created') {
          process.stdout.write(`  Added .github/workflows/deploy.yml (R2 deploy workflow)\n\n`);
        } else if (workflowResult === 'upgraded') {
          process.stdout.write(`  Upgraded .github/workflows/deploy.yml from CF Pages to R2\n\n`);
        }
        process.stdout.write(`Push your code so the live URL serves it:\n\n`);
        process.stdout.write(`  git remote add upstream ${autoResult.repoUrl}.git\n`);
        process.stdout.write(`  git push upstream main\n\n`);
        process.stdout.write(`Future commits to main auto-deploy in ~30s.\n`);
        process.stdout.write(`Run \`fas list\` any time to see your ${noun}s.\n`);
        return;
      }

      // ── Failure paths: every branch exits non-zero with an actionable message ──
      if (autoResult.kind === 'unauthorized') {
        // The server rejected our session (expired or invalid). Never say "not
        // authorized / no permission" — publishing needs none; this is purely
        // an expired-credential problem that `fas login` fixes.
        process.stdout.write(
          '\n✗ Publish failed: your fas session is no longer valid (it likely expired — sessions last 30 days).\n' +
            '  Run `fas login` to refresh it, then re-run `fas publish`.\n' +
            '  There is no separate publishing permission to request; a fresh login is all it takes.\n',
        );
        process.exit(1);
      }
      if (autoResult.kind === 'wrong_store') {
        process.stdout.write(`\n✗ Publish failed: ${autoResult.reason}\n`);
        process.exit(1);
      }
      // unconfigured | failed → a real platform-side problem. Tell the creator
      // exactly what broke and where to watch status, and exit non-zero so CI
      // and scripts see the failure. Nothing they did is wrong.
      process.stdout.write(
        `\n✗ Provisioning failed: ${autoResult.reason}\n` +
          `  This is a platform-side error, not a problem with your ${store === 'games' ? 'game' : 'app'} — your compliance checks passed.\n` +
          `  Nothing is queued; no submission form. Please retry shortly, and if it persists, report it.\n` +
          `  Live status: ${STATUS_URL}\n`,
      );
      process.exit(1);
    },
  );

interface AutoProvisionSuccess {
  kind: 'success';
  appUrl: string;
  repoUrl: string;
}
interface AutoProvisionFailure {
  kind: 'unconfigured' | 'failed' | 'unauthorized' | 'wrong_store';
  reason: string;
}
type AutoProvisionResult = AutoProvisionSuccess | AutoProvisionFailure;

async function tryAutoProvision(
  input: SubmissionInput,
  store: Store,
): Promise<AutoProvisionResult> {
  const config = await readConfig();
  const sessionToken = config.session?.token;
  if (!sessionToken) return { kind: 'unauthorized', reason: 'no fas session' };

  const typeShort = input.type.startsWith('Standalone') ? 'standalone' : 'connected';
  const res = await fetch(`${config.apiBase}/v1/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: input.name,
      store,
      category: input.category,
      type: typeShort,
      oneliner: input.oneliner,
      description: input.description,
      repo: input.repo,
      demo: input.demo,
    }),
  });
  if (res.status === 401) return { kind: 'unauthorized', reason: 'session expired' };
  if (res.status === 410) {
    // wrong_store: this CLI doesn't publish to that store (e.g. games → fgs).
    const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    return { kind: 'wrong_store', reason: body.hint ?? body.error ?? 'wrong store for this CLI' };
  }
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { kind: 'unconfigured', reason: body.error ?? '503' };
  }
  if (!res.ok) {
    const text = await res.text();
    return { kind: 'failed', reason: humanizeProvisionError(res.status, text) };
  }
  const result = (await res.json()) as { appUrl: string; repoUrl: string };
  return { kind: 'success', appUrl: result.appUrl, repoUrl: result.repoUrl };
}

/**
 * Turn a non-OK provision response into one concise, human-readable line.
 * The backend returns a few known JSON shapes (publish.ts):
 *   - { error: 'admin_provision_partial_failure', failedSteps: [{ name, detail }] }
 *   - { error: 'admin_provision_failed', status, body }
 *   - plain-text validation messages (400s)
 * Anything unrecognized falls back to a trimmed status + body so we never
 * surface a raw JSON blob to the user.
 */
export function humanizeProvisionError(status: number, body: string): string {
  const trimmed = body.trim();
  try {
    const j = JSON.parse(trimmed) as {
      error?: string;
      hint?: string;
      failedSteps?: { name?: string; detail?: string }[];
    };
    if (j.failedSteps?.length) {
      const steps = j.failedSteps
        .map((s) => (s.detail ? `${s.name} (${s.detail})` : s.name))
        .filter(Boolean)
        .join('; ');
      return `provisioning step failed: ${steps}`;
    }
    if (j.error) return j.hint ? `${j.error} — ${j.hint}` : j.error;
  } catch {
    // not JSON — fall through to the plain-text path
  }
  if (trimmed) return `${status}: ${trimmed.slice(0, 200)}`;
  return `server returned ${status}`;
}

/**
 * Match a user-supplied --category value (case-insensitive, ignores
 * trailing/leading whitespace) against the canonical labels.
 * Returns the canonical form or null if no match.
 */
export function resolveCategory(value: string): (typeof CATEGORIES)[number] | null {
  const normalized = value.trim().toLowerCase();
  for (const c of CATEGORIES) {
    if (c.toLowerCase() === normalized) return c;
  }
  // Allow short forms like "other" → "Other (specify in description)".
  if (normalized === 'other') return 'Other (specify in description)';
  return null;
}

/** Resolve --type short form ("standalone"|"connected") to the full label. */
export function resolveType(value: string): (typeof TYPES)[number] | null {
  const v = value.trim().toLowerCase();
  if (v === 'standalone' || v === TYPES[0].toLowerCase()) return TYPES[0];
  if (v === 'connected' || v === TYPES[1].toLowerCase()) return TYPES[1];
  return null;
}

interface ResolvedFlags {
  values: Partial<SubmissionInput>;
  errors: string[];
}

export function resolveFromFlags(opts: {
  name?: string;
  category?: string;
  type?: string;
  oneliner?: string;
  demo?: string;
}): ResolvedFlags {
  const values: Partial<SubmissionInput> = {};
  const errors: string[] = [];

  if (opts.name !== undefined) {
    try {
      assertValidAppId(opts.name);
      values.name = opts.name;
    } catch (e) {
      errors.push(e instanceof Error ? `--name: ${e.message}` : '--name invalid');
    }
  }
  if (opts.category !== undefined) {
    const c = resolveCategory(opts.category);
    if (c) values.category = c;
    else errors.push(`--category: not a known category. One of: ${CATEGORIES.join(', ')}`);
  }
  if (opts.type !== undefined) {
    const t = resolveType(opts.type);
    if (t) values.type = t;
    else errors.push('--type must be "standalone" or "connected"');
  }
  if (opts.oneliner !== undefined) {
    if (opts.oneliner.trim().length === 0) errors.push('--oneliner cannot be empty');
    else values.oneliner = opts.oneliner;
  }
  if (opts.demo !== undefined) {
    values.demo = opts.demo.trim() || null;
  }
  return { values, errors };
}

type PromptDef = prompts.PromptObject<string>;

export function buildPromptList(
  resolved: Partial<SubmissionInput>,
  defaults: { appName: string | null; description: string | null },
): PromptDef[] {
  const list: PromptDef[] = [];
  if (resolved.name === undefined) {
    list.push({
      type: 'text',
      name: 'name',
      message: 'App id (lowercase, used as subdomain)',
      initial: defaults.appName ?? '',
      validate: (value: string) => {
        try {
          assertValidAppId(value);
          return true;
        } catch (e) {
          return e instanceof Error ? e.message : 'invalid';
        }
      },
    });
  }
  if (resolved.category === undefined) {
    list.push({
      type: 'select',
      name: 'category',
      message: "Category (one app per category — check freeappstore.online for what's taken)",
      choices: CATEGORIES.map((c) => ({ title: c, value: c })),
    });
  }
  if (resolved.type === undefined) {
    list.push({
      type: 'select',
      name: 'type',
      message: 'App type',
      choices: TYPES.map((t) => ({ title: t, value: t })),
    });
  }
  if (resolved.oneliner === undefined) {
    list.push({
      type: 'text',
      name: 'oneliner',
      message: 'One-line description (shown on the storefront)',
      initial: defaults.description ?? '',
      validate: (v: string) => v.trim().length > 0 || 'required',
    });
  }
  if (resolved.demo === undefined) {
    list.push({
      type: 'text',
      name: 'demo',
      message: 'Demo URL (optional, leave blank if none)',
    });
  }
  return list;
}

async function detectAppName(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: string };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

async function detectDescription(): Promise<string | null> {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { description?: string };
    return pkg.description ?? null;
  } catch {
    return null;
  }
}

function detectGitRepo(): Promise<string | null> {
  return new Promise((resolveFn) => {
    const child = spawn('git', ['remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => (buf += chunk.toString()));
    child.on('close', (code) => {
      if (code !== 0) resolveFn(null);
      else resolveFn(parseGitHubRepo(buf.trim()));
    });
    child.on('error', () => resolveFn(null));
  });
}

export function parseGitHubRepo(url: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m?.[1] || !m[2]) return null;
  return `${m[1]}/${m[2]}`;
}

const DEPLOY_YML = `name: Deploy to R2

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-\${{ github.repository }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install
        run: pnpm install --frozen-lockfile

      # If your app uses VITE_* public config (OAuth client IDs, Firebase
      # config, etc.), add them as GitHub repo Variables and pass them here.
      # See https://freeappstore.online/skills.md "App Config & Secrets".
      # Example:
      #   env:
      #     VITE_GOOGLE_CLIENT_ID: \${{ vars.VITE_GOOGLE_CLIENT_ID }}
      - name: Build
        run: pnpm build

      - name: Verify build output
        run: |
          test -d ./web/dist || { echo "::error::No build output at web/dist"; exit 1; }
          test -n "$(ls -A ./web/dist)" || { echo "::error::web/dist is empty"; exit 1; }

      - name: Upload to R2
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          R2_ACCOUNT_ID: \${{ secrets.R2_ACCOUNT_ID }}
        run: |
          aws s3 sync ./web/dist "s3://fas-apps/apps/$\{GITHUB_REPOSITORY##*/}/" \\
            --endpoint-url "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \\
            --delete \\
            --no-progress
          echo "Deployed apps/$\{GITHUB_REPOSITORY##*/} from $\{GITHUB_SHA::7}"

      - name: Code health scan
        run: npx @vibecodeqa/cli@0.31 --json --badge > /dev/null 2>&1 || true
      - name: Upload code health
        if: always()
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: auto
          R2_ACCOUNT_ID: \${{ secrets.R2_ACCOUNT_ID }}
        run: |
          APP_ID="$\{GITHUB_REPOSITORY##*/}"
          EP="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
          if [ -f .vibe-check/report.json ]; then
            aws s3 cp .vibe-check/report.json "s3://fas-apps/apps/$APP_ID/.vcqa/report.json" \\
              --endpoint-url "$EP" --content-type application/json --no-progress
          fi
          if [ -f .vibe-check/badge.svg ]; then
            aws s3 cp .vibe-check/badge.svg "s3://fas-apps/apps/$APP_ID/.vcqa/badge.svg" \\
              --endpoint-url "$EP" --content-type image/svg+xml --no-progress
          fi
`;

/**
 * Ensure `.github/workflows/deploy.yml` exists and uses the current R2
 * template. If the file is missing it's created. If it already exists but
 * references legacy Cloudflare Pages hosting, it's overwritten and a
 * warning is printed so the user knows.
 *
 * Returns:
 *   'created'  — file was missing, now created
 *   'upgraded' — file existed with legacy CF Pages content, replaced with R2
 *   'ok'       — file already existed with R2 (or unknown) content, untouched
 */
export { DEPLOY_YML };
export type DeployWorkflowResult = 'created' | 'upgraded' | 'ok';
export async function ensureDeployWorkflow(): Promise<DeployWorkflowResult> {
  const target = join(process.cwd(), '.github', 'workflows', 'deploy.yml');
  try {
    const existing = await readFile(target, 'utf8');
    // Detect legacy CF Pages workflows — if the file references
    // "Cloudflare Pages" or "wrangler pages" it was generated by an
    // older CLI version and should be replaced with the R2 template.
    if (
      existing.includes('Cloudflare Pages') ||
      existing.includes('wrangler pages') ||
      existing.includes('pages deploy')
    ) {
      process.stderr.write(
        yellow('⚠ Your deploy workflow uses legacy CF Pages hosting. Upgrading to R2...\n'),
      );
      await writeFile(target, DEPLOY_YML);
      return 'upgraded';
    }
    return 'ok';
  } catch {
    // File doesn't exist — create it.
    await mkdir(join(process.cwd(), '.github', 'workflows'), { recursive: true });
    await writeFile(target, DEPLOY_YML);
    return 'created';
  }
}

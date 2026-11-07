import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fsFileSource,
  runChecks,
  runSourcePreflight,
  workflowDeployProblems,
} from '@freeappstore/compliance';
import { Command } from 'commander';
import prompts from 'prompts';
import { assertValidAppId } from '../lib/app-id.js';
import { readConfig, sessionDaysRemaining } from '../lib/config.js';
import { APP_STARTER_CONFIG, deployWorkflow } from '../lib/starter-foundation.js';
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

interface SubmissionInput {
  name: string;
  category: (typeof CATEGORIES)[number];
  type: (typeof TYPES)[number];
  oneliner: string;
  description: string;
  demo: string | null;
}

const DOMAIN = 'freeappstore.online';

// Where to look when provisioning is down. Surfaced on hard failures so a
// blocked creator can see status instead of being quietly shunted to a form.
const STATUS_URL = 'https://api.freeappstore.online/status';

export const publishCommand = new Command('publish')
  .description(
    'Publish this app. Provisions repo + hosting + DNS automatically. If provisioning fails, it fails loudly with the reason — there is no manual submission fallback.',
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
  .option(
    '--update-workflow',
    'Replace an existing .github/workflows/deploy.yml with the current canonical workflow. Without it, a differing file is left untouched and the drift is reported.',
  )
  .action(
    async (opts: {
      skipChecks?: boolean;
      name?: string;
      category?: string;
      type?: string;
      oneliner?: string;
      demo?: string;
      yes?: boolean;
      updateWorkflow?: boolean;
    }) => {
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

      // Refuse a cross-store project up front (FGS game published via fas publish).
      const storeErr = await assertFreeAppStoreProject(process.cwd());
      if (storeErr) {
        process.stdout.write(`\n✗ ${storeErr}\n`);
        process.exit(1);
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

      const appName = await detectAppName();
      const description = await detectDescription();

      process.stdout.write("\nLet's publish your app to FreeAppStore.\n");

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
        demo: merged.demo?.trim() ? merged.demo : null,
      };

      // Provision. There is no manual submission fallback: provisioning either
      // succeeds, or we fail loudly with the reason so it gets fixed (rather
      // than silently shunting the creator to a form they hate).
      const preflight = await runSourcePreflight(fsFileSource(process.cwd()), {
        expectedAppId: input.name,
      });
      if (!preflight.ok) {
        process.stdout.write(
          `\n✗ This app would fail its first deploy:\n${preflight.failures.map((f) => `    - ${f}\n`).join('')}`,
        );
        process.exit(1);
      }
      // A workflow that cannot deploy keylessly would leave a provisioned app
      // that fails on its first push. Refuse before anything is created.
      if (!opts.updateWorkflow) {
        const legacy = await legacyWorkflowReasons();
        if (legacy.length > 0) {
          process.stdout.write(
            `\n✗ .github/workflows/deploy.yml cannot deploy this app:\n${legacy.map((r) => `    - ${r}\n`).join('')}` +
              '  Replace it with the current workflow, then publish again:\n\n' +
              '    fas publish --update-workflow\n',
          );
          process.exit(1);
        }
      }
      const autoResult = await tryAutoProvision(input);
      if (autoResult.kind === 'success') {
        // Ensure the deploy workflow exists locally so the first push
        // triggers an R2 deploy. An existing file is only replaced with
        // --update-workflow; otherwise the drift is reported below.
        const workflowResult = await ensureDeployWorkflow({ update: opts.updateWorkflow === true });

        process.stdout.write(`\n✓ Provisioned!\n`);
        process.stdout.write(`  Launch URL: ${autoResult.appUrl}\n`);
        process.stdout.write(`  Repo:     ${autoResult.repoUrl}\n`);
        process.stdout.write(`  Listing:  https://${DOMAIN}/apps/${input.name}\n\n`);
        process.stdout.write(
          '  The listing appears after the first successful, publicly accessible deployment.\n\n',
        );
        if (workflowResult === 'created') {
          process.stdout.write(`  Added ${WORKFLOW_PATH} (R2 deploy workflow)\n\n`);
        } else if (workflowResult === 'updated') {
          process.stdout.write(
            `  Replaced .github/workflows/deploy.yml with the current workflow\n\n`,
          );
        } else if (typeof workflowResult === 'object') {
          process.stdout.write(
            yellow('  ⚠ .github/workflows/deploy.yml differs from the current workflow:\n') +
              workflowResult.drift.map((reason) => `    - ${reason}\n`).join('') +
              '    Left untouched. Re-run with --update-workflow to replace it.\n\n',
          );
        }
        // The repo is empty: it is not live until this commit (with the
        // workflow in it) is pushed. Commit the workflow here so it is part of
        // what gets pushed rather than an untracked file left behind.
        const committed =
          workflowResult === 'created' || workflowResult === 'updated'
            ? await commitDeployWorkflow()
            : 'unchanged';
        process.stdout.write(
          `The repository is empty, so ${autoResult.appUrl} is not live until you push your code:\n\n`,
        );
        if (committed === 'failed') {
          process.stdout.write(
            `  git add ${WORKFLOW_PATH}\n  git commit -m "Add deploy workflow"\n`,
          );
        }
        process.stdout.write(`  git remote add upstream ${autoResult.repoUrl}.git\n`);
        process.stdout.write(`  git push upstream main\n\n`);
        process.stdout.write(`Future commits to main auto-deploy in ~30s.\n`);
        process.stdout.write(`Run \`fas list\` any time to see your apps.\n`);
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
      // unconfigured | failed → a real platform-side problem. Tell the creator
      // exactly what broke and where to watch status, and exit non-zero so CI
      // and scripts see the failure. Nothing they did is wrong.
      process.stdout.write(
        `\n✗ Provisioning failed: ${autoResult.reason}\n` +
          `  This is a platform-side error, not a problem with your app — your compliance checks passed.\n` +
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
  kind: 'unconfigured' | 'failed' | 'unauthorized';
  reason: string;
}
type AutoProvisionResult = AutoProvisionSuccess | AutoProvisionFailure;

/**
 * Read `crossOriginIsolated` from the app's fas.json. `true`/`false` are
 * forwarded to provision so the host can send COOP/COEP (#286). Missing or
 * malformed files leave the existing route value unchanged.
 */
export async function readCrossOriginIsolatedFlag(
  root = process.cwd(),
): Promise<boolean | undefined> {
  try {
    const raw = await readFile(join(root, 'fas.json'), 'utf8');
    const parsed = JSON.parse(raw) as { crossOriginIsolated?: unknown };
    return typeof parsed?.crossOriginIsolated === 'boolean'
      ? parsed.crossOriginIsolated
      : undefined;
  } catch {
    return undefined;
  }
}

async function tryAutoProvision(input: SubmissionInput): Promise<AutoProvisionResult> {
  const config = await readConfig();
  const sessionToken = config.session?.token;
  if (!sessionToken) return { kind: 'unauthorized', reason: 'no fas session' };

  const typeShort = input.type.startsWith('Standalone') ? 'standalone' : 'connected';
  const crossOriginIsolated = await readCrossOriginIsolatedFlag();
  const res = await fetch(`${config.apiBase}/v1/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: input.name,
      store: 'apps',
      category: input.category,
      type: typeShort,
      oneliner: input.oneliner,
      description: input.description,
      demo: input.demo,
      ...(crossOriginIsolated !== undefined ? { crossOriginIsolated } : {}),
    }),
  });
  if (res.status === 401) return { kind: 'unauthorized', reason: 'session expired' };
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

/** FreeAppStore and FreeGameStore are SEPARATE stores — separate R2 buckets
 *  (fas-apps vs fgs-games), credentials, host workers and domains. A project
 *  scaffolded for FreeGameStore (uses @freegamestore/games, or a deploy.yml
 *  pinned to the fgs-games bucket) cannot deploy from FreeAppStore: the push
 *  fails opaquely at "Upload to R2" with AccessDenied (the FAS token has no
 *  access to fgs-games). Catch the mismatch HERE, before provisioning. */
export async function assertFreeAppStoreProject(cwd: string): Promise<string | null> {
  const read = async (rel: string): Promise<string> => {
    try {
      return await readFile(join(cwd, rel), 'utf8');
    } catch {
      return '';
    }
  };
  const haystack =
    (await read('web/package.json')) +
    '\n' +
    (await read('package.json')) +
    '\n' +
    (await read('.github/workflows/deploy.yml'));
  if (/@freegamestore\/games|fgs-games|freegamestore-host/.test(haystack)) {
    return "This looks like a FreeGameStore game (it uses @freegamestore/games or the fgs-games bucket). FreeGameStore and FreeAppStore are separate stores — publish it with `fgs publish` instead. Cross-publishing fails at R2 upload (AccessDenied) because each store's credentials only reach its own bucket.";
  }
  return null;
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

/** The canonical FreeAppStore deploy workflow — same generator as `fas init` and the builder. */
export const DEPLOY_YML = deployWorkflow(APP_STARTER_CONFIG);

export type DeployWorkflowResult = 'created' | 'ok' | 'updated' | { drift: string[] };

/**
 * Human-readable reasons an existing deploy.yml differs from the canonical
 * one. Security-relevant drift is named explicitly; anything else is counted.
 */
export function summarizeWorkflowDrift(existing: string, canonical: string): string[] {
  const reasons: string[] = [];
  if (/Cloudflare Pages|wrangler pages|pages deploy/.test(existing)) {
    reasons.push('targets legacy Cloudflare Pages hosting (decommissioned) instead of R2');
  }
  const unpinnedNpx = [...existing.matchAll(/\bnpx\s+(?:--yes\s+|-y\s+)?(\S+)/g)]
    .map((m) => m[1]!.replace(/^["']|["']$/g, ''))
    .filter((pkg) => !/^@?[\w.-]+(?:\/[\w.-]+)?@\d+\.\d+\.\d+$/.test(pkg));
  if (unpinnedNpx.length > 0) {
    reasons.push(`runs npx packages without an exact version (${unpinnedNpx.join(', ')})`);
  }
  const unpinnedActions = existing.match(/uses:\s*[\w.-]+\/[\w.-]+@(?![0-9a-f]{40}\b)\S+/g) ?? [];
  if (unpinnedActions.length > 0) {
    reasons.push(`uses tag-pinned actions instead of commit SHAs (${unpinnedActions.length})`);
  }
  if (/secrets\.R2_/.test(existing) && !/needs:\s*build/.test(existing)) {
    reasons.push('exposes the R2 secrets in the same job that installs and builds the app');
  }
  const existingLines = new Set(existing.split('\n'));
  const canonicalLines = new Set(canonical.split('\n'));
  let added = 0;
  let removed = 0;
  for (const line of canonicalLines) if (!existingLines.has(line)) added++;
  for (const line of existingLines) if (!canonicalLines.has(line)) removed++;
  reasons.push(`${removed} line(s) would be removed, ${added} added`);
  return reasons;
}

/**
 * Ensure `.github/workflows/deploy.yml` exists and matches the canonical
 * template. A missing file is created. An existing file is never overwritten
 * unless `update` is set — the creator may have customised it — so the
 * command reports what drifted and how to regenerate instead.
 *
 * Returns:
 *   'created'   — file was missing, now created
 *   'ok'        — file already matches the canonical workflow
 *   'updated'   — file differed and `update` replaced it
 *   { drift }   — file differs and was left untouched; `drift` lists why
 */
export async function ensureDeployWorkflow(
  opts: { update?: boolean } = {},
  cwd = process.cwd(),
): Promise<DeployWorkflowResult> {
  const dir = join(cwd, '.github', 'workflows');
  const target = join(dir, 'deploy.yml');
  let existing: string;
  try {
    existing = await readFile(target, 'utf8');
  } catch {
    await mkdir(dir, { recursive: true });
    await writeFile(target, DEPLOY_YML);
    return 'created';
  }
  if (existing === DEPLOY_YML) return 'ok';
  if (opts.update) {
    await writeFile(target, DEPLOY_YML);
    return 'updated';
  }
  return { drift: summarizeWorkflowDrift(existing, DEPLOY_YML) };
}

const WORKFLOW_PATH = '.github/workflows/deploy.yml';

/**
 * Why an existing deploy.yml cannot deploy keylessly (see workflowDeployProblems).
 * Empty when there is no file or it is deployable.
 */
export async function legacyWorkflowReasons(cwd = process.cwd()): Promise<string[]> {
  let existing: string;
  try {
    existing = await readFile(join(cwd, WORKFLOW_PATH), 'utf8');
  } catch {
    return [];
  }
  if (existing === DEPLOY_YML) return [];
  const reasons = workflowDeployProblems(existing);
  return reasons.length > 0 ? [...reasons, ...summarizeWorkflowDrift(existing, DEPLOY_YML)] : [];
}

function git(args: string[], cwd: string): Promise<number> {
  return new Promise((resolveFn) => {
    const child = spawn('git', args, { cwd, stdio: 'ignore' });
    child.on('exit', (code) => resolveFn(code ?? 1));
    child.on('error', () => resolveFn(1));
  });
}

/**
 * Commit only the deploy workflow, so a later `git push` carries it. 'failed'
 * (no git repo, no identity, hooks) leaves the file in place; the caller then
 * prints the explicit `git add`/`git commit` step.
 */
export async function commitDeployWorkflow(cwd = process.cwd()): Promise<'committed' | 'failed'> {
  if ((await git(['add', WORKFLOW_PATH], cwd)) !== 0) return 'failed';
  const code = await git(['commit', '-q', '-m', 'Add deploy workflow', '--', WORKFLOW_PATH], cwd);
  return code === 0 ? 'committed' : 'failed';
}

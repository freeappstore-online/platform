// update_files preflight (#549, #550): check the app AS IT WOULD BE after the
// push, with the same shared source preflight VibeCode and `fas publish` run,
// before anything is committed.

import { APP_ID_RE, isReservedAppId } from "../../../packages/backend/src/lib/apps";
import { runSourcePreflight, workflowDeployProblems } from "../../../packages/compliance/src/checks/source-preflight";

/** Read access to the app's current repository. */
export interface RepoReader {
  paths: string[];
  read(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
}

export interface FileChange {
  path: string;
  content: string;
}

const WORKFLOWS = new Set([".github/workflows/deploy.yml", ".github/workflows/deploy.yaml"]);

/** Reasons the push must be refused; empty when it is safe to push. */
export async function preflightUpdate(appId: string, changes: FileChange[], repo: RepoReader): Promise<string[]> {
  const failures: string[] = [];
  // The deploy workflow is platform-generated: overwriting it with one that cannot deploy keylessly breaks every later push.
  for (const change of changes) {
    if (!WORKFLOWS.has(change.path)) continue;
    for (const problem of workflowDeployProblems(change.content)) failures.push(`${change.path} ${problem}; keep the generated workflow (\`fas publish --update-workflow\` regenerates it)`);
  }

  const overlay = new Map(changes.map((c) => [c.path, c.content]));
  const existing = new Set(repo.paths);
  const encoder = new TextEncoder();
  const result = await runSourcePreflight(
    {
      async *list() {
        yield* new Set([...repo.paths, ...overlay.keys()]);
      },
      async read(path) {
        if (overlay.has(path)) return overlay.get(path)!;
        return existing.has(path) ? repo.read(path) : null;
      },
      async readBytes(path) {
        if (overlay.has(path)) return encoder.encode(overlay.get(path)!);
        return existing.has(path) ? repo.readBytes(path) : null;
      },
    },
    { expectedAppId: appId },
  );
  failures.push(...result.failures);
  return failures;
}

/** Reasons an app id cannot be created, checked before anything is provisioned. */
export function createAppProblems(appId: string): string[] {
  const problems: string[] = [];
  if (!APP_ID_RE.test(appId)) problems.push("app_id must be 2-31 characters: lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen");
  if (appId.startsWith("free") || appId.startsWith("pro")) problems.push("app_id must not start with 'free' or 'pro'");
  if (isReservedAppId(appId)) problems.push(`"${appId}" is reserved for the platform`);
  return problems;
}

/** What `create_app` should do given what an existing repository already holds. */
export type ScaffoldPlan =
  | { action: "scaffold"; skip: Set<string> }
  | { action: "already-scaffolded" };

/**
 * A repo with the deploy workflow was scaffolded already: refuse to overwrite it.
 * An empty repo, or one a failed run left without the workflow, is resumed by
 * pushing only the scaffold files it does not have.
 */
export function planScaffold(existingPaths: string[]): ScaffoldPlan {
  const existing = new Set(existingPaths);
  if (existing.has(".github/workflows/deploy.yml")) return { action: "already-scaffolded" };
  return { action: "scaffold", skip: existing };
}

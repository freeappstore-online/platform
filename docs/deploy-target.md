# Verify the app you deploy

Declare identity, build root, command and upload directory in fas.json. Preserve
other fields such as apis and crossOriginIsolated.

~~~json
{
  "appId": "taskflow",
  "deploy": {
    "root": "taskflow-react",
    "command": "pnpm build",
    "output": "taskflow-react/dist",
    "smoke": { "selector": "[data-fas-feature]", "text": "My tasks", "path": "/" }
  }
}
~~~

Paths are repository-relative and use forward slashes. Supported characters are
letters, digits, underscores, dots and hyphens. Root can be a dot for a
single-package app or apps/planner in a workspace. The command runs in root;
output is relative to the repository, not root, and must not contain the source
root. Build commands are app-owned shell code: review unfamiliar projects first.

Use the deployed literal id in initApp. The shared check follows the HTML entry
and relative JS/TS imports. It understands SDK import aliases and namespace
imports; rejects dynamic identities, spreads, placeholders and mismatches; and
ignores unrelated demos, comments and documentation strings. The graph currently
supports relative imports. Keep SDK initialization reachable through relative
imports when using bundler aliases. Source checks alone do not prove deployment.

Mark a visible product feature, for example an h1 with data-fas-feature and text
"My tasks". Choose functionality rather than an app name or starter greeting.
The known starter PageHeader instruction is rejected in reachable source. A
missing feature in the built artifact reports that the deployment may still
ship the starter or ignore the developed app. Multiple packages alone do not fail.

~~~sh
pnpm add -D --ignore-workspace-root-check playwright
pnpm exec playwright install chromium
fas check
fas doctor
fas buildcheck --app-id taskflow
~~~

Buildcheck requires fresh output. Explicitly clear only known build artifacts or
choose a fresh directory; the command never deletes files. It builds, serves
exactly output on loopback, and checks visible selector/text in Chromium. Build
failures, page runtime errors, missing features, escaped output paths and output
symlinks fail the command. The optional smoke path addresses the local artifact.
This smoke check complements the app's behavioural tests.

New CLI scaffolds and builder app seeds include the contract. Replace
REPLACE_WITH_A_REAL_FEATURE before release; it deliberately fails validation.
Preserve the contract when changing API configuration. Game scaffolds keep their
existing deployment flow.

Fas publish checks identity against the requested hosting id before provisioning,
even with --skip-checks. A new or upgraded legacy Pages workflow installs Chromium
and runs CLI 0.5+ buildcheck with the repository name as expected id. The build
step has id: artifact; upload uses steps.artifact.outputs.output, the exact path
verified in Chromium. Failed validation prevents upload.

Existing custom R2 workflows are preserved. Projects without a contract warn;
there is no fleet migration. Adopt by adding the contract and replacing the old
build/empty-directory gate with fas buildcheck, then uploading its output step
value. Publish the new CLI/compliance packages before running generated workflows
that require them. Source checks and old CI runs are not live deployment evidence.

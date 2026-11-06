/** Worker-safe deployment recipes. Keep dependency resolution in the app repository. */
export const APP_DEPLOY_CLI_VERSION = '0.4.78';

/** Exact @vibecodeqa/cli release the generated code-health scan runs (third-party scope: never floating). */
export const CODE_HEALTH_CLI_VERSION = '0.57.0';

/**
 * Every `uses:` in the generated deploy workflow is pinned to a commit SHA so a
 * moved tag cannot change what runs next to the R2 credentials. Resolve a new
 * pin with `gh api repos/<owner>/<repo>/tags` and keep the version comment.
 */
export const DEPLOY_ACTIONS = {
  checkout: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
  pnpm: 'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0',
  setupNode: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
  uploadArtifact: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2',
  downloadArtifact: 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0',
} as const;

export const INSTALL_APP_DEPENDENCIES = `set -euo pipefail
if [ ! -f pnpm-lock.yaml ]; then
  echo "Creating the first dependency lock for this app."
  pnpm install --no-frozen-lockfile
else
  log=$(mktemp)
  if pnpm install --frozen-lockfile >"$log" 2>&1; then
    cat "$log"
  else
    status=$?
    cat "$log"
    if grep -q 'ERR_PNPM_OUTDATED_LOCKFILE' "$log"; then
      echo "Dependency manifests changed; updating the app lock deliberately."
      pnpm install --no-frozen-lockfile
    else
      rm "$log"
      exit "$status"
    fi
  fi
  rm "$log"
fi
`;

/** Run only after typecheck/build/artifact validation and before deploying bytes. */
export const SAVE_APP_DEPENDENCY_LOCK = `set -euo pipefail
test -f pnpm-lock.yaml
git add -- pnpm-lock.yaml
if ! git diff --cached --quiet -- pnpm-lock.yaml; then
  git config user.name "FreeAppStore dependency lock"
  git config user.email "dependency-lock@freeappstore.online"
  git commit -m "build: retain verified dependency resolution [skip ci]" -- pnpm-lock.yaml
  # A normal push rejects concurrent main changes; never overwrite newer app work.
  git push origin HEAD:main
fi
echo "Accepted source: $(git rev-parse HEAD)"
`;

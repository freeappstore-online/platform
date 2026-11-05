/** Worker-safe deployment recipes. Keep dependency resolution in the app repository. */
export const APP_DEPLOY_CLI_VERSION = '0.4.67';

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

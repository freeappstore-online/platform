#!/usr/bin/env bash
set -euo pipefail
# Publication alone is not acceptance. Wait for source CI and actual browser scaffolds.
for workflow in ci.yml scaffold-smoke.yml; do
  deadline=$(( $(date +%s) + 1200 ))
  while true; do
    result=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$workflow/runs?head_sha=$GITHUB_SHA&event=push&per_page=10" --jq '.workflow_runs[0] | if .status == "completed" then .conclusion else "pending" end')
    if [ "$result" = success ]; then break; fi
    if [ "$result" != pending ] && [ "$result" != null ] && [ -n "$result" ]; then
      echo "Source gate $workflow: $result"; exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "Timed out waiting for $workflow on $GITHUB_SHA"; exit 1; fi
    sleep 10
  done
done
# The fresh main clone does not inherit actions/checkout's local extraheader.
# gh reads the existing job token without embedding it in remotes or output.
gh auth setup-git --hostname github.com
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# npm pack verifies registry integrity; the accepted generator must match the published package.
npm pack "@freeappstore/cli@$CLI_VERSION" --pack-destination "$scratch" --json > "$scratch/pack.json"
archive=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[0].filename)' "$scratch/pack.json")
tar -xzf "$scratch/$archive" -C "$scratch"
# Re-read main immediately before each normal push so concurrent work is preserved.
for attempt in 1 2 3; do
  target="$scratch/target-$attempt"
  git clone --quiet --depth 1 --branch main "$(git remote get-url origin)" "$target"
  cp "$target/releases/starter.json" "$scratch/previous.json" 2>/dev/null || printf 'null\n' > "$scratch/previous.json"
  node scripts/template-release.mjs accept "$scratch/package/dist" "$CLI_VERSION" "$SDK_VERSION" "$GITHUB_SHA" "$scratch/previous.json"
  mkdir -p "$target/releases"
  cp "$scratch/previous.json" "$target/releases/starter.json"
  git -C "$target" add releases/starter.json
  if git -C "$target" diff --cached --quiet; then echo 'Accepted release already recorded'; exit 0; fi
  git -C "$target" -c user.name='FreeAppStore release' -c user.email='release@freeappstore.online' commit -m 'build: record accepted starter release [skip ci]'
  if git -C "$target" push origin HEAD:main; then echo 'Published-package and source acceptance recorded; mirror adoption is separate.'; exit 0; fi
done
echo 'Acceptance record push failed; inspect Git authentication/permissions or concurrent main updates. Rerun this job, do not republish.'
exit 1

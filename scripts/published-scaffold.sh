# Shared by the real publication workflow and deterministic shell tests.
wait_for_published_version() {
  local package="$1" version="$2" actual="unavailable" attempt=0
  local deadline="${PUBLISHED_REGISTRY_DEADLINE:-$(( $(date +%s) + 300 ))}"
  local remaining request_seconds fetch_timeout_ms sleep_seconds
  while true; do
    remaining=$(( deadline - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then break; fi
    attempt=$((attempt + 1))
    request_seconds=$(( remaining < 5 ? remaining : 5 ))
    fetch_timeout_ms=$(( request_seconds * 1000 - 500 ))
    if actual=$(timeout "${request_seconds}s" npm view "$package@$version" version \
      --registry=https://registry.npmjs.org --prefer-online \
      --fetch-retries=0 --fetch-timeout="$fetch_timeout_ms" 2>/dev/null) && [ "$actual" = "$version" ]; then
      echo "Available: $package@$version (attempt $attempt; within five-minute deadline)"
      return 0
    fi
    remaining=$(( deadline - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then break; fi
    sleep_seconds=$(( remaining < 5 ? remaining : 5 ))
    echo "Waiting for $package@$version on https://registry.npmjs.org (check $attempt; ${remaining}s remain)"
    sleep "$sleep_seconds"
  done
  echo "::error::$package@$version did not become available on https://registry.npmjs.org within five minutes; last response: ${actual:-unavailable}"
  return 1
}

# Metadata can become visible before npm's install packument catches up (#398).
# Retry only ETARGET or the selected CLI archive 404 before a target directory exists.
# Never replay a partial init or an unrelated download failure.
initialize_published_scaffold() {
  local target="$1"; shift
  local deadline="${PUBLISHED_REGISTRY_DEADLINE:-$(( $(date +%s) + 300 ))}"
  local remaining pause status output
  output=$(mktemp)
  while true; do
    remaining=$(( deadline - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then break; fi
    if timeout "${remaining}s" npx --yes --prefer-online --fetch-retries=0 \
      "@freeappstore/cli@$CLI_VERSION" init "$target" "$@" >"$output" 2>&1; then
      cat "$output"
      rm "$output"
      return 0
    else
      status=$?
    fi
    cat "$output"
    if [ -e "$target" ] || [ "$status" -eq 124 ] || [ "$status" -eq 137 ] || {
      ! grep -q 'ETARGET' "$output" &&
      ! grep -Fq "404 Not Found - GET https://registry.npmjs.org/@freeappstore/cli/-/cli-${CLI_VERSION}.tgz -" "$output"
    }; then
      echo "::error::Published scaffold initialization failed; not replaying a partial, timed-out or unrelated operation."
      rm "$output"
      return "$status"
    fi
    remaining=$(( deadline - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then break; fi
    pause=$(( remaining < 5 ? remaining : 5 ))
    echo "Registry metadata is visible but the selected CLI release is not downloadable yet; retrying within the original deadline."
    sleep "$pause"
  done
  rm "$output"
  echo "::error::Published CLI initialization did not resolve within the shared five-minute deadline."
  return 1
}

# SDK metadata may be visible while its exact archive still returns 404 (#411).
# Only the selected archive's propagation failure is retryable here.
install_published_scaffold_dependencies() {
  local deadline="${PUBLISHED_REGISTRY_DEADLINE:-$(( $(date +%s) + 300 ))}"
  local remaining pause status output
  output=$(mktemp)
  while true; do
    remaining=$(( deadline - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then break; fi
    if timeout "${remaining}s" pnpm install --no-frozen-lockfile >"$output" 2>&1; then
      cat "$output"
      rm "$output"
      return 0
    else
      status=$?
    fi
    cat "$output"
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ] || ! grep -F 'ERR_PNPM_FETCH_404' "$output" | grep -Fq "GET https://registry.npmjs.org/@freeappstore/sdk/-/sdk-${SDK_VERSION}.tgz:"; then
      rm "$output"
      return "$status"
    fi
    remaining=$(( deadline - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then break; fi
    pause=$(( remaining < 5 ? remaining : 5 ))
    echo "Selected SDK archive is not available yet; retrying within the original deadline."
    sleep "$pause"
  done
  rm "$output"
  echo "::error::Published scaffold dependency installation exceeded the shared five-minute deadline."
  return 1
}

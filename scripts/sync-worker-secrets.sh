#!/usr/bin/env bash
#
# Sync a Worker's runtime secrets from the private SOPS repo
# (`serge-ivo/secrets`) to Cloudflare via wrangler.
#
# Doppler is retired. Secret values live in:
#   $SECRETS_REPO_DIR/secrets.enc.yaml
#
# Usage:
#   SECRETS_PROJECT=fas bash scripts/sync-worker-secrets.sh <worker-dir>
#
# The worker dir must contain `.worker-secrets`: one key per line, with blank
# lines and #comments ignored. Each key is read from:
#   ["$SECRETS_PROJECT"]["KEY"]
#
# Required local tools: sops, jq, wrangler through the worker's pnpm package.
# Required env for wrangler: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail

WORKER_DIR="${1:?usage: sync-worker-secrets.sh <worker-dir>}"
MANIFEST="$WORKER_DIR/.worker-secrets"
PROJECT="${SECRETS_PROJECT:-fas}"
SECRETS_REPO_DIR="${SECRETS_REPO_DIR:-$HOME/dev/secrets}"
SECRETS_FILE="${SECRETS_FILE:-$SECRETS_REPO_DIR/secrets.enc.yaml}"
SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
export SOPS_AGE_KEY_FILE

if [ ! -f "$MANIFEST" ]; then
  echo "no manifest at $MANIFEST — nothing to sync"
  exit 0
fi

if [ ! -f "$SECRETS_FILE" ]; then
  echo "missing SOPS secrets file: $SECRETS_FILE" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

jq_args=()
count=0
while IFS= read -r raw || [ -n "$raw" ]; do
  key="$(printf '%s' "$raw" | tr -d '[:space:]')"
  [ -z "$key" ] && continue
  case "$key" in \#*) continue ;; esac

  if ! val="$(sops -d --extract "[\"$PROJECT\"][\"$key\"]" "$SECRETS_FILE")"; then
    echo "missing [$PROJECT][$key] in $SECRETS_FILE" >&2
    exit 1
  fi

  jq_args+=(--arg "$key" "$val")
  count=$((count + 1))
done < "$MANIFEST"

if [ "$count" -eq 0 ]; then
  echo "manifest $MANIFEST has no keys — nothing to sync"
  exit 0
fi

jq -n "${jq_args[@]}" '$ARGS.named' > "$tmp"
echo "Syncing $count secret(s) from SOPS project $PROJECT -> $(basename "$WORKER_DIR")"
(cd "$WORKER_DIR" && pnpm exec wrangler secret bulk "$tmp")

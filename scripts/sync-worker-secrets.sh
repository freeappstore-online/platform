#!/usr/bin/env bash
#
# Sync a Worker's secrets from Doppler (fas/prd) → Cloudflare via wrangler.
#
# Doppler is the single source of truth for Worker secrets. This script is the
# ONLY sanctioned way they get set — never `wrangler secret put` by hand, which
# silently drifts (see the 2026-06-17 provisioning outage: backend/admin held
# three different INTERNAL_TOKEN values). CI runs this BEFORE `wrangler deploy`
# so new code always finds its secrets already present.
#
# Usage: scripts/sync-worker-secrets.sh <worker-dir>
#   <worker-dir> must contain a `.doppler-secrets` manifest: one Doppler key
#   name per line (blank lines and #comments ignored). Each is pushed as a
#   Worker secret of the SAME name. `wrangler secret bulk` only adds/updates the
#   listed keys — it never deletes secrets absent from the file — so a manifest
#   can safely cover a subset of a Worker's secrets.
#
# Required env:
#   DOPPLER_TOKEN          read-scoped service token for fas/prd
#   CLOUDFLARE_API_TOKEN   } used by `wrangler secret bulk`
#   CLOUDFLARE_ACCOUNT_ID  }
# Optional env: DOPPLER_PROJECT (default fas), DOPPLER_CONFIG (default prd)
#
set -euo pipefail

WORKER_DIR="${1:?usage: sync-worker-secrets.sh <worker-dir>}"
MANIFEST="$WORKER_DIR/.doppler-secrets"
PROJECT="${DOPPLER_PROJECT:-fas}"
CONFIG="${DOPPLER_CONFIG:-prd}"

if [ ! -f "$MANIFEST" ]; then
  echo "no manifest at $MANIFEST — nothing to sync"
  exit 0
fi
: "${DOPPLER_TOKEN:?DOPPLER_TOKEN required (read-scoped service token for $PROJECT/$CONFIG)}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Assemble { KEY: value, ... } with jq --arg so secret values never hit argv of
# any other process or get echoed. Values come straight from Doppler.
jq_args=()
count=0
while IFS= read -r raw || [ -n "$raw" ]; do
  key="$(printf '%s' "$raw" | tr -d '[:space:]')"
  [ -z "$key" ] && continue
  case "$key" in \#*) continue ;; esac
  val="$(doppler secrets get "$key" --project "$PROJECT" --config "$CONFIG" --plain)"
  jq_args+=(--arg "$key" "$val")
  count=$((count + 1))
done < "$MANIFEST"

if [ "$count" -eq 0 ]; then
  echo "manifest $MANIFEST has no keys — nothing to sync"
  exit 0
fi

jq -n "${jq_args[@]}" '$ARGS.named' > "$tmp"
echo "Syncing $count secret(s) from Doppler $PROJECT/$CONFIG → $(basename "$WORKER_DIR")"
( cd "$WORKER_DIR" && pnpm exec wrangler secret bulk "$tmp" )

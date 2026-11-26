#!/bin/sh
# The scheme's build pre-action (#832): records the source commit in Config/Commit.xcconfig (untracked), which
# Config/Version.xcconfig includes, so a local build shows its commit. CI overrides FAS_COMMIT on the command line.
set -eu
DIR="${SRCROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
COMMIT=$(git -C "$DIR" rev-parse --short=7 HEAD 2>/dev/null || echo dev)
LINE="FAS_COMMIT = $COMMIT"
[ "$(cat "$DIR/Config/Commit.xcconfig" 2>/dev/null)" = "$LINE" ] || echo "$LINE" > "$DIR/Config/Commit.xcconfig"

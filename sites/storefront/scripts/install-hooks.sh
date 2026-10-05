#!/usr/bin/env bash
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
git config --local core.hooksPath .githooks
echo "Git hooks installed! Commits run npm run lint; pushes run npm run test:security."
echo "Hooks are optional convenience checks; CI enforces these checks independently."
echo "To uninstall: git config --local --unset core.hooksPath"

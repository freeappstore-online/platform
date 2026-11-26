#!/usr/bin/env bash
# Versions of the desktop, Android and iOS apps (#832, docs/versioning.md). Each app's version lives in one
# committed file, and each release is a tag <app>-v<version> on the commit that set it:
#   desktop  desktop/package.json           "version"
#   android  android/version.properties     versionName
#   ios      ios/Config/Version.xcconfig    MARKETING_VERSION
#
#   app-release.sh version <app>          print the committed version
#   app-release.sh cut <app> <version>    write <version>, commit it to main, push, and tag that commit (CI only)
#   app-release.sh notes <app> <tag>      release notes: the app's commits since its previous release tag
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command=${1:?usage: app-release.sh version|cut|notes <app> ...}
app=${2:?app: desktop, android or ios}
case "$app" in
  desktop) file=desktop/package.json ;;
  android) file=android/version.properties ;;
  ios) file=ios/Config/Version.xcconfig ;;
  *) echo "Unknown app: $app (desktop, android or ios)" >&2; exit 1 ;;
esac
dir=${file%%/*}

current() {
  case "$app" in
    desktop) node -p "require('./desktop/package.json').version" ;;
    android) sed -n 's/^versionName=//p' "$file" ;;
    ios) sed -n 's/^MARKETING_VERSION *= *//p' "$file" ;;
  esac
}

write() {
  case "$app" in
    desktop) (cd desktop && npm pkg set "version=$1") ;;
    android) perl -pi -e "s/^versionName=.*/versionName=$1/" "$file" ;;
    ios) perl -pi -e "s/^MARKETING_VERSION *=.*/MARKETING_VERSION = $1/" "$file" ;;
  esac
}

case "$command" in
  version) current ;;
  cut)
    version=${3:?version, e.g. 0.3.0}
    tag="$app-v$version"
    if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then echo "Not a semver version: $version" >&2; exit 1; fi
    if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then echo "$tag already exists" >&2; exit 1; fi
    was=$(current)
    # The committed version may already be the one being released (a first release); never go backwards.
    if [ "$(printf '%s\n%s\n' "$was" "$version" | sort -V | tail -n 1)" != "$version" ]; then
      echo "$version is older than the committed $app version $was" >&2; exit 1
    fi
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    if [ "$was" != "$version" ]; then
      write "$version"
      git add "$file"
      git commit -m "release: $app $version"
      git pull --rebase origin main
      git push origin HEAD:main
    fi
    git tag "$tag"
    git push origin "refs/tags/$tag"
    echo "Tagged $tag at $(git rev-parse HEAD)"
    ;;
  notes)
    tag=${3:?tag}
    previous=$(git describe --tags --abbrev=0 --match "$app-v*" "$tag^" 2>/dev/null || true)
    range=${previous:+$previous..}$tag
    echo "Changes to the $app app${previous:+ since $previous}:"
    echo
    git log --no-merges --invert-grep --grep='^release: ' --format='- %s (%h)' -n 100 "$range" -- "$dir" | grep . || echo '- No app changes.'
    ;;
  *) echo "Unknown command: $command" >&2; exit 1 ;;
esac

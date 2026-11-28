#!/usr/bin/env bash
# Uses an already-authorized Xcode account and Apple's cloud-managed Developer ID signer.
# Private keys remain with Apple. Produces only verified, stapled app ZIPs; never installs them.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/../.." && pwd)
version=${1:?Usage: cloud-sign-mac.sh VERSION BUILD_NUMBER}
build_number=${2:?Usage: cloud-sign-mac.sh VERSION BUILD_NUMBER}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid version' >&2; exit 1; }
[[ "$build_number" =~ ^[1-9][0-9]*$ ]] || { echo 'A numeric release build number is required' >&2; exit 1; }
tag="desktop-v$version"
team=55DT52UQXE
cd "$root"
[[ $(git branch --show-current) == main ]] || { echo 'Run from main only' >&2; exit 1; }
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'Tracked source changes must be committed first' >&2; exit 1
fi
[[ -z $(git ls-files --others --exclude-standard desktop) ]] || { echo 'Untracked desktop source must be reviewed first' >&2; exit 1; }
commit=$(git rev-parse HEAD)
[[ $(git rev-parse "$tag^{commit}") == "$commit" ]] || { echo 'HEAD must be the exact release tag commit' >&2; exit 1; }
[[ $(node -p 'require("./desktop/package.json").version') == "$version" ]] || { echo 'Source version differs from release tag' >&2; exit 1; }
spctl --status | grep -Fxq 'assessments enabled'
output="$root/build/cloud-release-$version-$build_number"
[[ ! -e "$output" ]] || { echo "Output exists; preserve it and inspect before retrying: $output" >&2; exit 1; }
mkdir -p "$output/archives" "$output/notarized" "$output/installers"
cd "$root/desktop"
pnpm install --frozen-lockfile
FAS_BUILD_NUMBER="$build_number" pnpm build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --x64 --arm64 --dir --publish never --config.directories.output="$output/unsigned"

for arch in x64 arm64; do
  dir=mac; [[ "$arch" != arm64 ]] || dir=mac-arm64
  archive="$output/archives/$arch.xcarchive"
  mkdir -p "$archive/Products/Applications"
  ditto "$output/unsigned/$dir/FreeAppStore.app" "$archive/Products/Applications/FreeAppStore.app"
  python3 - "$archive" "$output/upload-options.plist" "$team" <<'PY'
import sys, plistlib
from pathlib import Path
from datetime import datetime
archive, options, team = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
info = plistlib.loads((archive/'Products/Applications/FreeAppStore.app/Contents/Info.plist').read_bytes())
metadata = {'ArchiveVersion': 2, 'CreationDate': datetime.now(), 'Name': 'FreeAppStore', 'SchemeName': 'FreeAppStore', 'ApplicationProperties': {'ApplicationPath': 'Applications/FreeAppStore.app', 'CFBundleIdentifier': info['CFBundleIdentifier'], 'CFBundleShortVersionString': info['CFBundleShortVersionString'], 'CFBundleVersion': info['CFBundleVersion'], 'SigningIdentity': '-', 'Team': team}}
(archive/'Info.plist').write_bytes(plistlib.dumps(metadata))
options.write_bytes(plistlib.dumps({'method': 'developer-id', 'destination': 'upload', 'signingStyle': 'automatic', 'teamID': team, 'stripSwiftSymbols': False}))
PY
  echo "Signing and submitting $arch through the authorized Xcode account."
  if ! xcodebuild -exportArchive -archivePath "$archive" -exportPath "$output/upload-$arch" -exportOptionsPlist "$output/upload-options.plist" -allowProvisioningUpdates > "$output/upload-$arch.log" 2>&1; then
    echo "Xcode signing/upload failed for $arch. Inspect the private local log; do not publish it: $output/upload-$arch.log" >&2
    exit 1
  fi
done

for arch in x64 arm64; do
  archive="$output/archives/$arch.xcarchive"
  app="$output/notarized/$arch/FreeAppStore.app"
  deadline=$((SECONDS + 3600))
  while ! xcodebuild -exportNotarizedApp -archivePath "$archive" -exportPath "$output/notarized/$arch" > "$output/notarized-$arch.log" 2>&1; do
    # A rejected submission must never become an indefinite retry or a signature-only fallback.
    if ! grep -Fq 'is processing and not ready for distribution' "$output/notarized-$arch.log"; then
      echo "Notarized export failed for $arch. Inspect the private local log: $output/notarized-$arch.log" >&2
      exit 1
    fi
    [[ $SECONDS -lt $deadline ]] || { echo "Apple is still processing $arch after one hour; no release was produced." >&2; exit 1; }
    echo "Apple is still processing $arch; checking again in 30 seconds."
    sleep 30
  done
  codesign --verify --deep --strict "$app"
  details=$(codesign -dv --verbose=4 "$app" 2>&1)
  grep -Fq 'Authority=Developer ID Application:' <<< "$details"
  grep -Fxq "TeamIdentifier=$team" <<< "$details"
  grep -Eq 'flags=.*runtime' <<< "$details"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
  lipo -verify_arch "$([[ $arch == x64 ]] && echo x86_64 || echo arm64)" "$app/Contents/MacOS/FreeAppStore"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$output/installers/FreeAppStore-mac-$arch.zip"
done

python3 - "$output" "$version" "$build_number" "$commit" "$team" <<'PY'
import sys, json, hashlib
from pathlib import Path
output, version, build, commit, team = Path(sys.argv[1]), *sys.argv[2:]
artifacts = [{'name': p.name, 'sha256': hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()} for p in sorted((output/'installers').glob('*.zip'))]
(output/'cloud-signing-input.json').write_text(json.dumps({'version': version, 'tag': f'desktop-v{version}', 'commit': commit, 'build': build, 'team': team, 'artifacts': artifacts}, indent=2)+'\n')
print('Verified Mac ZIPs ready for the separate source-bound CI promotion gate:', output/'installers')
PY

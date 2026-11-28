#!/usr/bin/env bash
# Verify every shipped Mac architecture; notarize and staple the disk images as well as the apps.
set -euo pipefail
: "${APPLE_API_KEY:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}" "${APPLE_TEAM_ID:?}"
spctl --status | grep -Fxq 'assessments enabled'
verify_app() {
  codesign --verify --deep --strict --verbose=2 "$1"
  details=$(codesign -dv --verbose=4 "$1" 2>&1)
  grep -Fq 'Authority=Developer ID Application:' <<< "$details"
  grep -Fxq "TeamIdentifier=$APPLE_TEAM_ID" <<< "$details"
  grep -Eq 'flags=.*runtime' <<< "$details"
  xcrun stapler validate "$1"
  spctl --assess --type execute --verbose=2 "$1"
}
verify_tmp=$(mktemp -d)
trap 'rm -rf "$verify_tmp"' EXIT
for arch in x64 arm64; do
  dir=mac; [[ "$arch" != arm64 ]] || dir=mac-arm64
  app="release/$dir/FreeAppStore.app"
  verify_app "$app"
  # Check the shipped ZIP, not only builder's unpacked staging directory.
  ditto -x -k "release/FreeAppStore-mac-$arch.zip" "$verify_tmp/$arch"
  verify_app "$verify_tmp/$arch/FreeAppStore.app"
  dmg="release/FreeAppStore-mac-$arch.dmg"
  xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --output-format json > "release/notarization-$arch.json"
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["status"] == "Accepted", "Disk image notarization was not accepted"' "release/notarization-$arch.json"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
done

node scripts/refresh-mac-update.mjs
printf '%s\n' '{"schemaVersion":1,"developerId":true,"notarized":true,"gatekeeperAccepted":true,"architectures":["x64","arm64"]}' > release/mac-signing-verification.json

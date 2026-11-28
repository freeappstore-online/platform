#!/usr/bin/env bash
# Verify every shipped Mac architecture; notarize and staple the disk images as well as the apps.
set -euo pipefail
: "${APPLE_API_KEY:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}" "${APPLE_TEAM_ID:?}"
for arch in x64 arm64; do
  dir=mac; [[ "$arch" != arm64 ]] || dir=mac-arm64
  app="release/$dir/FreeAppStore.app"
  codesign --verify --deep --strict --verbose=2 "$app"
  details=$(codesign -dv --verbose=4 "$app" 2>&1)
  grep -Fq 'Authority=Developer ID Application:' <<< "$details"
  grep -Fxq "TeamIdentifier=$APPLE_TEAM_ID" <<< "$details"
  grep -Eq 'flags=.*runtime' <<< "$details"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
  dmg="release/FreeAppStore-mac-$arch.dmg"
  xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --output-format json > "release/notarization-$arch.json"
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["status"] == "Accepted", "Disk image notarization was not accepted"' "release/notarization-$arch.json"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
done

node scripts/refresh-mac-update.mjs

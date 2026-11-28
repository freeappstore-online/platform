#!/bin/bash
# Ephemeral GitHub runner only; never a developer-device installation path.
set -euo pipefail
umask 077
for name in RUNNER_TEMP IOS_DIST_CERT_P12_BASE64 IOS_DIST_CERT_PASSWORD IOS_APPSTORE_PROFILE_BASE64 ASC_API_KEY_ID ASC_API_ISSUER_ID ASC_API_KEY_P8_BASE64 IOS_TEAM_ID IOS_BUILD_NUMBER; do
  if [[ -z "${!name}" ]]; then echo "Missing $name" >&2; exit 1; fi
done
[[ "$IOS_TEAM_ID" =~ ^[A-Z0-9]{10}$ && "$IOS_BUILD_NUMBER" =~ ^[0-9]+$ ]] || exit 1
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'Signing runs only on the ephemeral CI runner.' >&2; exit 1; }
work=$(mktemp -d "$RUNNER_TEMP/fas-ios-signing.XXXXXX")
keychain="$work/signing.keychain-db"
profile_path=''
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  if [[ -n "$profile_path" ]]; then rm -f "$profile_path"; fi
  rm -rf "$work"
}
trap cleanup EXIT
keychain_password=$(openssl rand -hex 24)
# Generated keychain passwords are never written to logs, artifacts or persistent storage.
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
printf '%s' "$IOS_DIST_CERT_P12_BASE64" | base64 --decode > "$work/dist.p12"
security import "$work/dist.p12" -k "$keychain" -P "$IOS_DIST_CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
rm -f "$work/dist.p12"
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security find-identity -v -p codesigning "$keychain" | grep -F 'Apple Distribution:' >/dev/null || { echo 'No valid Apple Distribution signing identity.' >&2; exit 1; }
printf '%s' "$IOS_APPSTORE_PROFILE_BASE64" | base64 --decode > "$work/app.mobileprovision"
security cms -D -i "$work/app.mobileprovision" > "$work/profile.plist"
python3 ios/release/validate-profile.py "$work/profile.plist" "$IOS_TEAM_ID" online.freeappstore.companion
uuid=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$work/profile.plist")
[[ "$uuid" =~ ^[A-Fa-f0-9-]+$ ]] || exit 1
profile_path="$HOME/Library/MobileDevice/Provisioning Profiles/$uuid.mobileprovision"
mkdir -p "$(dirname "$profile_path")"
cp "$work/app.mobileprovision" "$profile_path"
printf '%s' "$ASC_API_KEY_P8_BASE64" | base64 --decode > "$work/AuthKey.p8"
unset IOS_DIST_CERT_P12_BASE64 IOS_DIST_CERT_PASSWORD IOS_APPSTORE_PROFILE_BASE64 ASC_API_KEY_P8_BASE64
xcodebuild -project ios/FreeAppStore.xcodeproj -scheme FreeAppStore -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$work/FreeAppStore.xcarchive" archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$IOS_TEAM_ID" CODE_SIGN_IDENTITY='Apple Distribution' \
  PROVISIONING_PROFILE_SPECIFIER="$uuid" OTHER_CODE_SIGN_FLAGS="--keychain $keychain" \
  CURRENT_PROJECT_VERSION="$IOS_BUILD_NUMBER" FAS_COMMIT="${GITHUB_SHA:0:7}" FAS_DEV_BUILD=NO
app="$work/FreeAppStore.xcarchive/Products/Applications/FreeAppStore.app"
test -f "$app/PrivacyInfo.xcprivacy"
test -f "$app/Frameworks/SherpaOnnxC.framework/PrivacyInfo.xcprivacy"
codesign --verify --deep --strict "$app"
security cms -D -i "$app/embedded.mobileprovision" > "$work/archived-profile.plist"
python3 ios/release/validate-profile.py "$work/archived-profile.plist" "$IOS_TEAM_ID" online.freeappstore.companion
codesign -d --entitlements :- "$app" > "$work/entitlements.plist" 2>/dev/null
python3 - "$work/entitlements.plist" "$IOS_TEAM_ID" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'rb') as f: e=plistlib.load(f)
assert e.get('get-task-allow') is not True, 'Archive permits debugging'
assert e.get('application-identifier') == sys.argv[2]+'.online.freeappstore.companion', 'Wrong signed application'
PY
python3 - "$work/ExportOptions.plist" "$IOS_TEAM_ID" "$uuid" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as f:
    plistlib.dump({'method':'app-store-connect','destination':'upload','teamID':sys.argv[2],
      'signingStyle':'manual','signingCertificate':'Apple Distribution',
      'provisioningProfiles':{'online.freeappstore.companion':sys.argv[3]},
      'manageAppVersionAndBuildNumber':False,'uploadSymbols':True},f)
PY
xcodebuild -exportArchive -archivePath "$work/FreeAppStore.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$work/export" \
  -authenticationKeyPath "$work/AuthKey.p8" -authenticationKeyID "$ASC_API_KEY_ID" -authenticationKeyIssuerID "$ASC_API_ISSUER_ID"
echo 'Upload completed. Apple processing and tester availability must still be verified.'

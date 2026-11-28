#!/bin/sh
# Kokoro TTS for Contribute (#733): the official sherpa-onnx iOS xcframework (Apache-2.0), the dynamic framework with
# onnxruntime linked in. Its static variant has no onnxruntime in the x86_64 simulator slice. It ships only as a GitHub
# release asset, so the scheme's build pre-action runs this to fetch it once into ios/Vendor (untracked); it is refused
# unless it matches the pinned SHA-256. Same sherpa-onnx version as the Android AAR (android/app/build.gradle.kts).
set -eu
VERSION=2.0.3
SHA256=6e35088e42c7ccbacea6377d198cca5e0e05262b11f17c9225af445a5bbb5c5e
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/xcframework/sherpa-onnx-v$VERSION-ios-shared-onnxruntime-static.xcframework.zip"
DIR="${SRCROOT:-$(cd "$(dirname "$0")/.." && pwd)}/Vendor"
STAMP="$DIR/sherpa-onnx.sha256"

install_privacy_manifest() {
  for framework in "$DIR"/SherpaOnnxC.xcframework/*/SherpaOnnxC.framework; do
    cp "$DIR/../Privacy/SherpaOnnxC.xcprivacy" "$framework/PrivacyInfo.xcprivacy"
  done
}
if [ -d "$DIR/SherpaOnnxC.xcframework" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SHA256" ]; then
  install_privacy_manifest
  exit 0
fi
rm -rf "$DIR/SherpaOnnxC.xcframework" "$STAMP"
mkdir -p "$DIR"
PART="$DIR/sherpa-onnx.zip.part"
curl -fsSLo "$PART" "$URL"
if ! echo "$SHA256  $PART" | shasum -a 256 -c - >/dev/null; then
  rm -f "$PART"
  echo "error: sherpa-onnx $VERSION does not match its pinned SHA-256" >&2
  exit 1
fi
unzip -q -o "$PART" -d "$DIR"
rm -f "$PART"
echo "$SHA256" > "$STAMP"

# Xcode re-signs the embedded framework after adding its required privacy resource.
install_privacy_manifest

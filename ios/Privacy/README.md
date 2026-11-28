# Embedded framework privacy

The pinned SherpaOnnxC 2.0.3 dynamic framework does not ship a privacy manifest. It imports `stat` and `fstat` (verified with `nm -u` on the device slice) to read model/audio file metadata. This app provides only files in its own container to the offline TTS engine, so its bundled manifest declares `C617.1`. The SDK itself collects no data and uses no network service; the app's optional upload behavior is declared in the app manifest.

`fetch-sherpa-onnx.sh` installs this manifest in both framework slices before Xcode embeds and re-signs them. The binary and download pin are unchanged. Review SDK source/imports and update the declaration when changing the SDK or its usage. Apple's app-level manifest does not substitute for the embedded framework's declaration.

"""Bind an unsigned CI archive to the expected workflow commit/build before local signing."""
import json
import pathlib
import plistlib
import re
import sys


def inspect(archive, expected_sha, expected_build, expected_version):
    if not re.fullmatch(r'[0-9a-f]{40}', expected_sha) or not re.fullmatch(r'[1-9][0-9]*', expected_build):
        raise ValueError('Invalid expected commit or build')
    app = pathlib.Path(archive) / 'Products/Applications/FreeAppStore.app'
    with (app / 'Info.plist').open('rb') as source:
        info = plistlib.load(source)
    if info.get('CFBundleIdentifier') != 'online.freeappstore.companion':
        raise ValueError('Unexpected archive bundle ID')
    if str(info.get('CFBundleVersion')) != expected_build or info.get('FASCommit') != expected_sha[:7] or info.get('FASDevBuild') != 'NO':
        raise ValueError('Archive build/commit is not the expected release')
    sdk = re.fullmatch(r'iphoneos(\d+)(?:\.\d+)*', info.get('DTSDKName', ''))
    if not sdk or int(sdk[1]) < 26:
        raise ValueError('Archive requires iOS 26 or newer SDK')
    version = info.get('CFBundleShortVersionString', '')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or version != expected_version:
        raise ValueError('Invalid marketing version')
    for manifest in [app / 'PrivacyInfo.xcprivacy', app / 'Frameworks/SherpaOnnxC.framework/PrivacyInfo.xcprivacy']:
        with manifest.open('rb') as source:
            plistlib.load(source)
    return {'repository': 'freeappstore-online/platform', 'commit': expected_sha, 'build': expected_build,
            'bundleId': info['CFBundleIdentifier'], 'version': version, 'sdk': info['DTSDKName']}


if __name__ == '__main__':
    mode, archive, manifest, sha, build, version = sys.argv[1:]
    actual = inspect(archive, sha, build, version)
    if mode == 'create':
        pathlib.Path(manifest).write_text(json.dumps(actual, indent=2) + '\n')
    elif mode == 'verify':
        if json.loads(pathlib.Path(manifest).read_text()) != actual:
            sys.exit('Archive manifest does not match inspected application')
    else:
        sys.exit('Use create or verify')
    print(f'Validated {actual["bundleId"]} {actual["version"]} ({build}), {sha}, {actual["sdk"]}')

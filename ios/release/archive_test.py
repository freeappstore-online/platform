import importlib.util
import pathlib
import plistlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('archive_manifest', pathlib.Path(__file__).with_name('archive-manifest.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ArchiveTests(unittest.TestCase):
    def test_identity_version_and_sdk_are_bound_to_expected_ci_run(self):
        with tempfile.TemporaryDirectory() as directory:
            app = pathlib.Path(directory) / 'Products/Applications/FreeAppStore.app'
            (app / 'Frameworks/SherpaOnnxC.framework').mkdir(parents=True)
            for name in ['PrivacyInfo.xcprivacy', 'Frameworks/SherpaOnnxC.framework/PrivacyInfo.xcprivacy']:
                with (app / name).open('wb') as f: plistlib.dump({}, f)
            good = {'CFBundleIdentifier':'online.freeappstore.companion', 'CFBundleVersion':'80',
                    'CFBundleShortVersionString':'0.2.0', 'FASCommit':'abcdef0', 'FASDevBuild':'NO', 'DTSDKName':'iphoneos26.2'}
            def check(info):
                with (app / 'Info.plist').open('wb') as f: plistlib.dump(info, f)
                return module.inspect(directory, 'abcdef0' + '0' * 33, '80', '0.2.0')
            self.assertEqual(check(good)['sdk'], 'iphoneos26.2')
            for patch in [{'CFBundleIdentifier':'another.app'}, {'CFBundleVersion':'79'}, {'CFBundleShortVersionString':'0.1.0'},
                          {'FASCommit':'old1234'}, {'FASDevBuild':'YES'}, {'DTSDKName':'iphoneos18.0'}]:
                with self.assertRaises(ValueError): check(good | patch)
            (app / 'Frameworks/SherpaOnnxC.framework/PrivacyInfo.xcprivacy').unlink()
            with self.assertRaises(FileNotFoundError): check(good)

import copy
import datetime
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('profile_validation', pathlib.Path(__file__).with_name('validate-profile.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ProfileTests(unittest.TestCase):
    def test_rejects_non_appstore_or_mismatched_profiles(self):
        profile = {'ExpirationDate': datetime.datetime(2099, 1, 1), 'TeamIdentifier': ['TEAM123456'],
                   'DeveloperCertificates': [b'certificate'], 'Entitlements': {'get-task-allow': False,
                   'beta-reports-active': True, 'application-identifier': 'TEAM123456.online.freeappstore.companion'}}
        module.validate(profile, 'TEAM123456', 'online.freeappstore.companion')
        for patch in [{'ProvisionedDevices': []}, {'ProvisionsAllDevices': True}, {'ExpirationDate': datetime.datetime(2000, 1, 1)},
                      {'TeamIdentifier': ['OTHERTEAM1']}, {'DeveloperCertificates': []}]:
            with self.assertRaises(ValueError): module.validate(profile | patch, 'TEAM123456', 'online.freeappstore.companion')
        for patch in [{'get-task-allow': True}, {'beta-reports-active': False}, {'application-identifier': 'TEAM123456.other'}]:
            bad = copy.deepcopy(profile); bad['Entitlements'].update(patch)
            with self.assertRaises(ValueError): module.validate(bad, 'TEAM123456', 'online.freeappstore.companion')

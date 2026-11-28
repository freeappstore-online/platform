"""Reject development, ad-hoc, enterprise, expired or mismatched distribution profiles."""
import datetime
import plistlib
import sys


def validate(profile, team, bundle, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    expiry = profile.get('ExpirationDate')
    if not isinstance(expiry, datetime.datetime):
        raise ValueError('Profile has no expiration date')
    if expiry.replace(tzinfo=datetime.timezone.utc) <= now:
        raise ValueError('Profile has expired')
    entitlements = profile.get('Entitlements', {})
    if 'ProvisionedDevices' in profile or profile.get('ProvisionsAllDevices'):
        raise ValueError('Not an App Store distribution profile')
    if entitlements.get('get-task-allow') is not False or entitlements.get('beta-reports-active') is not True:
        raise ValueError('Profile is not eligible for TestFlight distribution')
    if profile.get('TeamIdentifier') != [team] or entitlements.get('application-identifier') != f'{team}.{bundle}':
        raise ValueError('Profile team or bundle does not match')
    if not profile.get('DeveloperCertificates'):
        raise ValueError('Profile has no signing certificate')


if __name__ == '__main__':
    try:
        with open(sys.argv[1], 'rb') as source:
            validate(plistlib.load(source), sys.argv[2], sys.argv[3])
        print('App Store distribution profile validated')
    except (ValueError, KeyError) as error:
        sys.exit(str(error))

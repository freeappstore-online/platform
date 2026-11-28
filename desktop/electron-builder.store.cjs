// Store submission package: Microsoft signs it after certification. Never distribute this unsigned APPX directly.
const smoke = process.env.FAS_STORE_SMOKE === '1';
const version = require('./package.json').version;
if (
  !smoke &&
  (!/^[1-9]\d*\.\d+\.\d+$/.test(version) || version.split('.').some((part) => Number(part) > 65535))
)
  throw new Error(
    'Microsoft Store requires a 1.x or later release with version components at most 65535',
  );
// biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these package macros.
const storeArtifactName = 'FreeAppStore-store-${version}-${arch}.appx';
const required = (key, fixture) => {
  const value = smoke ? fixture : process.env[key];
  if (!value) throw new Error(`Missing Partner Center identity: ${key}`);
  return value;
};
module.exports = {
  extends: './electron-builder.yml',
  ...(smoke ? { extraMetadata: { version: '1.0.0' } } : {}),
  directories: { output: 'release-store' },
  forceCodeSigning: false,
  publish: null,
  win: { target: [{ target: 'appx', arch: ['x64'] }], signExecutable: false },
  appx: {
    artifactName: smoke ? 'FreeAppStore-store-smoke.appx' : storeArtifactName,
    applicationId: 'FreeAppStore',
    identityName: required('WINDOWS_STORE_IDENTITY_NAME', 'FreeAppStore.CISmoke'),
    publisher: required('WINDOWS_STORE_PUBLISHER', 'CN=FreeAppStore CI smoke only'),
    publisherDisplayName: required('WINDOWS_STORE_PUBLISHER_DISPLAY_NAME', 'CI smoke only'),
    displayName: 'FreeAppStore',
    languages: ['en-US'],
    minVersion: '10.0.17763.0',
    setBuildNumber: false,
    addAutoLaunchExtension: false,
    customExtensionsPath: 'build/store-startup.xml',
    capabilities: ['runFullTrust'],
  },
};

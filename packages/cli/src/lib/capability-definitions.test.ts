import { minVersion, subset, validRange } from 'semver';
import { expect, it } from 'vitest';
import { satisfiesCapabilityPackageRange } from './capability-definitions.js';

it.each([
  ['0.16.26-beta.1', '>=0.16.26', false],
  ['^0.16.26-beta.1', '>=0.16.26', false],
  ['>=0.16.26 <0.17.0', '>=0.16.26', true],
  ['>= 0.16.26 < 0.17.0', '>=0.16.26', true],
  ['1.3.x', '^1.0.0', true],
  ['0.16.26+build.1', '>=0.16.26', true],
  ['0.16.26 - 0.16.30', '>=0.16.26', true],
  ['^0.16.26', '>=0.16.26', true],
  ['~1.0.0', '^1.0.0', true],
  ['^1.2.3', '>=1.0.0', true],
  ['1.x', '>=1.0.0', true],
  ['^1.0.0 || ^2.0.0', '>=1.0.0', true],
  ['^0.9.0 || ^1.0.0', '>=1.0.0', false],
  ['1.0.0-alpha.1', '>=1.0.0', false],
  ['2.x', '^1.0.0', false],
  ['*', '>=1.0.0', false],
  ['<0.0.0', '>=0.0.0', false],
  ['workspace:^1.0.0', '>=1.0.0', false],
  ['file:../sdk', '>=1.0.0', false],
  ['git+https://github.com/example/sdk.git', '>=1.0.0', false],
  ['latest', '>=1.0.0', false],
  ['broken', '>=1.0.0', false],
  [undefined, '>=1.0.0', false],
  [123, '>=1.0.0', false],
  ['1.0.0', 'broken', false],
  ['1.0.0', '<0.0.0', false],
])('checks %s against %s as %s', (declared, required, expected) => {
  expect(satisfiesCapabilityPackageRange(declared, required, { validRange, minVersion, subset })).toBe(expected);
});

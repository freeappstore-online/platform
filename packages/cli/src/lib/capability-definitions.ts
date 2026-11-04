import { minVersion, subset, validRange } from 'semver';

/**
 * Pure prerequisite policy shared by filesystem installers and Worker callers.
 * Every version allowed by the declaration must satisfy the requirement.
 * Keep npm's default prerelease semantics; workspace/file/git specs are unproven.
 */
export function satisfiesCapabilityPackageRange(declared: unknown, required: string): boolean {
  return (
    typeof declared === 'string' &&
    !!validRange(declared) &&
    !!minVersion(declared) &&
    !!validRange(required) &&
    !!minVersion(required) &&
    subset(declared, required)
  );
}

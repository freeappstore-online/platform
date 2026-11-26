import { readFileSync } from 'node:fs';

/** The build number ("dev" for a local build) and commit, from dist/build-info.json (scripts/build-info.mjs, #832). */
export interface BuildInfo {
  build: string;
  commit: string;
}

export function loadBuildInfo(path: string): BuildInfo {
  return JSON.parse(readFileSync(path, 'utf8')) as BuildInfo;
}

/** "0.3.0 (57, abc1234)", or "0.3.0 (dev, abc1234)" for a local build. */
export const versionLabel = (version: string, { build, commit }: BuildInfo) =>
  `${version} (${build}, ${commit})`;

/** The GitHub release notes for this version (docs/versioning.md). */
export const releaseNotesUrl = (version: string) =>
  `https://github.com/freeappstore-online/platform/releases/tag/desktop-v${version}`;

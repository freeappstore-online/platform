import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

const NAME = 'SDK UI styles compiled';
const SDK_UI_IMPORT_RE = /from\s*['"]@freeappstore\/sdk\/ui['"]/;
const SDK_SOURCE_RE = /@source\s+['"][^'"]*@freeappstore\/sdk[^'"]*['"]/;

/** Minor version of the declared SDK range; null when it can't be read (workspace:, missing). */
async function sdkMinor(source: FileSource): Promise<number | null> {
  for (const path of ['web/package.json', 'package.json']) {
    const text = await source.read(path);
    if (!text) continue;
    try {
      const pkg = JSON.parse(text);
      const spec =
        pkg.dependencies?.['@freeappstore/sdk'] ?? pkg.devDependencies?.['@freeappstore/sdk'];
      const match = typeof spec === 'string' ? /^\D*0\.(\d+)\./.exec(spec) : null;
      if (match) return Number(match[1]);
    } catch {}
  }
  return null;
}

/**
 * Since SDK 0.16 the app's Tailwind build compiles the SDK's classes, so a
 * stylesheet must `@source` the SDK. Without it every SDK-only class is
 * silently dropped: on 2026-11-23 the calendar shell lost `flex-col` and laid
 * its header out beside the page, 62px wider than a 360px phone (#648).
 * Earlier SDKs injected their own styles at runtime and need no @source.
 */
export async function checkSdkUiStyles(source: FileSource): Promise<CheckResult> {
  let importer: string | null = null;
  let sourced = false;
  for await (const path of source.list()) {
    if (!path.startsWith('web/src/')) continue;
    const isCss = path.endsWith('.css');
    if (!isCss && !/\.[jt]sx?$/.test(path)) continue;
    const content = await source.read(path);
    if (!content) continue;
    if (isCss && SDK_SOURCE_RE.test(content)) sourced = true;
    if (!isCss && !importer && SDK_UI_IMPORT_RE.test(content)) importer = path;
  }
  if (!importer) return { name: NAME, status: 'pass', detail: 'no @freeappstore/sdk/ui import' };
  if (sourced) return { name: NAME, status: 'pass', detail: 'a stylesheet @sources the SDK' };
  const minor = await sdkMinor(source);
  if (minor !== null && minor < 16) {
    return { name: NAME, status: 'pass', detail: `SDK 0.${minor} injects its own styles` };
  }
  return {
    name: NAME,
    status: 'fail',
    detail: `${importer} imports @freeappstore/sdk/ui but no web/src stylesheet @sources the SDK, so its Tailwind classes are never generated`,
    suggestions: [
      'In web/src/index.css, after @import "tailwindcss";, add:\n' +
        '@source "../node_modules/@freeappstore/sdk/dist";\n' +
        '@source "../../node_modules/@freeappstore/sdk/dist";',
    ],
  };
}

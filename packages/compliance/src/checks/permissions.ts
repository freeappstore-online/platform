import type { FileSource } from '../lib/file-source.js';
import {
  detectPermissions,
  isPermissionId,
  PERMISSION_IDS,
  PERMISSIONS_MANIFEST_PATH,
  readDeclaredPermissions,
} from '../lib/permissions.js';
import type { CheckResult } from '../types.js';

const NAME = 'Permissions declared';

/**
 * Warns when the app uses a browser permission (microphone, camera, location…)
 * that its manifest doesn't declare (#285). The storefront listing shows the
 * declared and detected permissions, so users know what the app will ask for;
 * declaring adds the one-line reason shown next to each.
 */
export async function checkPermissions(source: FileSource): Promise<CheckResult> {
  const detected = await detectPermissions(source);
  const declared = (await readDeclaredPermissions(source)) ?? [];
  const declaredNames = new Set(declared.map((d) => d.name));

  const unknown = [...declaredNames].filter((n) => !isPermissionId(n));
  const undeclared = [...detected.keys()].filter((id) => !declaredNames.has(id));

  if (unknown.length === 0 && undeclared.length === 0) {
    const used = [...declaredNames];
    return {
      name: NAME,
      status: 'pass',
      detail: used.length ? `asks for: ${used.join(', ')}` : 'asks for no browser permissions',
    };
  }

  const problems: string[] = [];
  if (undeclared.length) {
    problems.push(
      `uses ${undeclared.map((id) => `${id} (${detected.get(id)})`).join(', ')} without declaring it`,
    );
  }
  if (unknown.length) problems.push(`unknown permission name(s): ${unknown.join(', ')}`);

  const example = undeclared[0] ?? 'microphone';
  return {
    name: NAME,
    status: 'warn',
    detail: problems.join('; '),
    suggestions: [
      `Add them to "permissions" in ${PERMISSIONS_MANIFEST_PATH}, with a one-line reason shown on your listing: "permissions": [{ "name": "${example}", "reason": "…" }]`,
      `Valid names: ${PERMISSION_IDS.join(', ')}.`,
    ],
  };
}

import type { FileSource } from '../lib/file-source.js';
import { stylesheets } from '../lib/styling.js';
import type { CheckResult } from '../types.js';

function translucent(value: string): boolean {
  if (/\btransparent\b/i.test(value)) return true;
  for (const match of value.matchAll(/#([\da-f]{8}|[\da-f]{4})\b/gi)) {
    const hex = match[1]!.toLowerCase();
    if (
      !hex.endsWith(hex.length === 4 ? 'f' : 'ff') &&
      !hex.endsWith(hex.length === 4 ? 'F' : 'FF')
    )
      return true;
  }
  for (const match of value.matchAll(
    /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(([^()]*)\)/gi,
  )) {
    const args = match[1]!;
    const alpha = args.includes('/')
      ? args.split('/').at(-1)
      : args.split(',').length === 4
        ? args.split(',').at(-1)
        : undefined;
    if (alpha !== undefined && Number.parseFloat(alpha) < (alpha.includes('%') ? 100 : 1))
      return true;
  }
  return false;
}

export async function checkOpaqueSurface(source: FileSource): Promise<CheckResult> {
  const findings: string[] = [];
  for await (const { path, root } of stylesheets(source)) {
    root?.walkDecls((decl) => {
      if (/^--(?:paper|panel|popover)$/.test(decl.prop) && translucent(decl.value)) {
        findings.push(`${path}:${decl.source?.start?.line ?? 1}: ${decl.prop}: ${decl.value}`);
      }
    });
  }
  return {
    name: 'Opaque surfaces',
    status: findings.length ? 'warn' : 'pass',
    detail: findings.length
      ? findings.join('; ')
      : '--paper, --panel and --popover have no translucent colours',
    ...(findings.length
      ? {
          suggestions: [
            'Keep floating UI opaque in both themes; use --popover: var(--paper). Reserve glass effects for --panel-glass.',
          ],
        }
      : {}),
  };
}

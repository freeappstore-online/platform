import type { AnyNode } from 'postcss';
import type { FileSource } from '../lib/file-source.js';
import { isTokenRule, stylesheets, within } from '../lib/styling.js';
import type { CheckResult } from '../types.js';

/** #324: warn-only CSS structure checks, parsed with PostCSS. */
export async function checkCssDiscipline(source: FileSource): Promise<CheckResult> {
  const findings: string[] = [];
  for await (const { path, root, error } of stylesheets(source)) {
    if (!root) {
      findings.push(`${path}: css-parse: ${error}`);
      continue;
    }
    const classes = new Set<string>();
    root.walkRules((rule) => {
      const token = isTokenRule(rule);
      let print = false;
      let keyframes = false;
      let darkMedia = false;
      for (let p: AnyNode | undefined = rule.parent; p; p = p.parent) {
        if (p.type === 'atrule' && p.name === 'media' && /^print\b/.test(p.params)) print = true;
        if (p.type === 'atrule' && /keyframes$/.test(p.name)) keyframes = true;
        if (
          p.type === 'atrule' &&
          p.name === 'media' &&
          /prefers-color-scheme\s*:\s*dark/.test(p.params)
        )
          darkMedia = true;
      }
      const location = `${path}:${rule.source?.start?.line ?? 1}`;
      if (!token && !within(rule, 'layer') && !within(rule, 'theme') && !print && !keyframes) {
        findings.push(`${location}: unlayered-rule: ${rule.selector}`);
      }
      if (!token && (darkMedia || /(?:data-theme\s*=\s*["']?dark|\.dark\b)/.test(rule.selector))) {
        findings.push(`${location}: per-screen-dark-override: ${rule.selector}`);
      }
      if (!token && !keyframes) {
        for (const match of rule.selector.matchAll(/\.([\w-]+)/g)) classes.add(match[1]!);
      }
    });
    root.walkDecls((decl) => {
      const location = `${path}:${decl.source?.start?.line ?? 1}`;
      if (
        /^--(?:bg|surface|border|glass|dock|error)$/.test(decl.prop) ||
        /var\(\s*--(?:bg|surface|border|glass|dock|error)(?=\s*[,)])/.test(decl.value)
      ) {
        findings.push(`${location}: banned-alias: ${decl.prop}: ${decl.value}`);
      }
      const token = decl.parent?.type === 'rule' && isTokenRule(decl.parent);
      if (!token && /#[\da-f]{3,8}\b/i.test(decl.value)) {
        findings.push(`${location}: hex-outside-tokens: ${decl.prop}`);
      }
    });
    if (classes.size > 15)
      findings.push(`${path}: feature-classes: ${classes.size} (threshold: 15)`);
  }
  return {
    name: 'CSS discipline',
    status: findings.length ? 'warn' : 'pass',
    detail: findings.length ? findings.join('; ') : 'CSS follows the FAS styling standard',
    ...(findings.length
      ? {
          suggestions: [
            'Use Tailwind on FAS tokens; keep custom rules in @layer base/components and colours in :root token blocks.',
          ],
        }
      : {}),
  };
}

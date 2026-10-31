import postcss, { type Node, type Root, type Rule } from 'postcss';
import type { FileSource } from './file-source.js';

export function isTokenRule(rule: Rule): boolean {
  return rule.selectors.every((selector) =>
    /^:root(?:\[data-theme\s*=\s*["']?(?:dark|light)["']?\])?$/.test(selector.trim()),
  );
}

export function within(node: Node, name: string): boolean {
  for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && 'name' in parent && parent.name === name) return true;
  }
  return false;
}

export async function* stylesheets(source: FileSource): AsyncGenerator<{
  path: string;
  root?: Root;
  error?: string;
}> {
  for await (const path of source.list()) {
    if (!path.startsWith('web/src/') || !path.endsWith('.css')) continue;
    const css = await source.read(path);
    if (css === null) continue;
    try {
      yield { path, root: postcss.parse(css, { from: path }) };
    } catch (error) {
      yield { path, error: String(error) };
    }
  }
}

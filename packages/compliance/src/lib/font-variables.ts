/** Keep every declaration: a different selector/file may shadow the theme. */
export type FontVariables = ReadonlyMap<string, ReadonlySet<string>>;

export function collectFontVariables(contents: Iterable<string>): FontVariables {
  const variables = new Map<string, Set<string>>();
  for (const content of contents) {
    const declarations = /(?:^|[;{\s])(--[\w-]+)\s*:/g;
    for (const match of content.matchAll(declarations)) {
      const start = match.index + match[0].length;
      let end = start;
      let quote = '';
      let depth = 0;
      for (; end < content.length; end++) {
        const char = content[end]!;
        if (char === '\\') {
          end++;
          continue;
        }
        if (quote) {
          if (char === quote) quote = '';
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          continue;
        }
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (!depth && /[;{}]/.test(char)) break;
      }
      const values = variables.get(match[1]!) ?? new Set<string>();
      values.add(
        content
          .slice(start, end)
          .trim()
          .replace(/\s*!important\s*$/i, ''),
      );
      variables.set(match[1]!, values);
    }
  }
  return variables;
}

/** Split CSS lists without treating a var() fallback's commas as separators. */
export function splitFontStack(value: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && !depth) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/** CSS dependency cycles invalidate every variable in the cycle, including fallbacks. */
function cyclicVariables(variables: FontVariables): Set<string> {
  const graph = new Map<string, Set<string>>();
  for (const [name, values] of variables) {
    const references = new Set<string>();
    for (const value of values) {
      const unquoted = value.replace(/"[^"\n]*"|'[^'\n]*'/g, '');
      for (const reference of unquoted.matchAll(/var\(\s*(--[\w-]+)/gi))
        references.add(reference[1]!);
    }
    graph.set(name, references);
  }
  const cyclic = new Set<string>();
  const indices = new Map<string, number>();
  const lows = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  let index = 0;
  // Strongly connected components include cycles reached through already visited branches.
  function visit(name: string): void {
    indices.set(name, index);
    lows.set(name, index++);
    stack.push(name);
    active.add(name);
    for (const next of graph.get(name) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lows.set(name, Math.min(lows.get(name)!, lows.get(next)!));
      } else if (active.has(next)) lows.set(name, Math.min(lows.get(name)!, indices.get(next)!));
    }
    if (lows.get(name) !== indices.get(name)) return;
    const component: string[] = [];
    let next: string;
    do {
      next = stack.pop()!;
      active.delete(next);
      component.push(next);
    } while (next !== name);
    if (component.length > 1 || graph.get(name)?.has(name))
      for (const member of component) cyclic.add(member);
  }
  for (const name of graph.keys()) if (!indices.has(name)) visit(name);
  return cyclic;
}

/** Null means unresolved/invalid, never an exemption from font validation. */
export function resolveFontVariables(value: string, variables: FontVariables): string[] | null {
  const cyclic = cyclicVariables(variables);
  function expand(input: string, trail: ReadonlySet<string>, depth: number): string[] | null {
    if (depth > 32) return null;
    let quote = '';
    for (let i = 0; i < input.length; i++) {
      const char = input[i]!;
      if (char === '\\') {
        i++;
        continue;
      }
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (input.slice(i, i + 4).toLowerCase() !== 'var(') continue;
      let end = i + 4;
      let nesting = 1;
      let innerQuote = '';
      for (; end < input.length; end++) {
        const inner = input[end]!;
        if (inner === '\\') {
          end++;
          continue;
        }
        if (innerQuote) {
          if (inner === innerQuote) innerQuote = '';
          continue;
        }
        if (inner === '"' || inner === "'") {
          innerQuote = inner;
          continue;
        }
        if (inner === '(') nesting++;
        if (inner === ')' && --nesting === 0) break;
      }
      if (nesting) return null;
      const args = splitFontStack(input.slice(i + 4, end));
      const name = args.shift()!.trim();
      if (!/^--[\w-]+$/.test(name)) return null;
      const fallback = args.length ? args.join(',') : null;
      const nextTrail = new Set([...trail, name]);
      const declarations = !trail.has(name) && !cyclic.has(name) ? variables.get(name) : undefined;
      const choices = declarations?.size ? [...declarations] : [null];
      const output: string[] = [];
      for (const declaration of choices) {
        let values = declaration === null ? null : expand(declaration, nextTrail, depth + 1);
        if (values === null && fallback !== null) values = expand(fallback, trail, depth + 1);
        if (values === null) return null;
        for (const resolved of values) {
          const rest = expand(
            input.slice(0, i) + resolved + input.slice(end + 1),
            trail,
            depth + 1,
          );
          if (rest === null || output.length + rest.length > 32) return null;
          output.push(...rest);
        }
      }
      return output;
    }
    return [input];
  }
  return expand(value, new Set(), 0);
}

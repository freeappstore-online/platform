/**
 * In-worker deploy preflight. This deliberately catches only high-confidence
 * build failures before pushing generated code to GitHub, where a red CI run
 * would otherwise leave the old R2 artifact live while the session looks shipped.
 */

const SRC_RE = /^web\/src\/.+\.(?:tsx?|jsx?|mjs|cjs)$/;

export interface SanityFinding {
  file: string;
  problem: string;
}

type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";
type ScanState = {
  out: string[];
  mode: Mode;
  i: number;
  src: string;
};

export function stripToSkeleton(src: string): string {
  const state: ScanState = { out: [], mode: "code", i: 0, src };
  while (state.i < src.length) {
    switch (state.mode) {
      case "code":
        scanCode(state);
        break;
      case "line":
        scanLine(state);
        break;
      case "block":
        scanBlock(state);
        break;
      case "dq": {
        scanQuoted(state, '"');
        break;
      }
      case "sq": {
        scanQuoted(state, "'");
        break;
      }
      case "tpl":
        scanTemplate(state);
        break;
    }
  }
  return state.out.join("");
}

function current(state: ScanState): string {
  return state.src[state.i] ?? "";
}

function next(state: ScanState): string {
  return state.i + 1 < state.src.length ? state.src[state.i + 1]! : "";
}

function blank(state: ScanState, ch: string): void {
  state.out.push(ch === "\n" ? "\n" : " ");
}

function scanCode(state: ScanState): void {
  const c = current(state);
  const c2 = next(state);
  if (c === "/" && c2 === "/") {
    state.mode = "line";
    blank(state, c);
    state.i++;
    return;
  }
  if (c === "/" && c2 === "*") {
    state.mode = "block";
    blank(state, c);
    state.i++;
    return;
  }
  if (c === '"' || c === "'" || c === "`") {
    state.mode = c === '"' ? "dq" : c === "'" ? "sq" : "tpl";
    state.out.push(c);
    state.i++;
    return;
  }
  state.out.push(c);
  state.i++;
}

function scanLine(state: ScanState): void {
  const c = current(state);
  if (c === "\n") {
    state.mode = "code";
    state.out.push("\n");
  } else blank(state, c);
  state.i++;
}

function scanBlock(state: ScanState): void {
  const c = current(state);
  if (c === "*" && next(state) === "/") {
    state.mode = "code";
    blank(state, c);
    state.out.push(" ");
    state.i += 2;
    return;
  }
  blank(state, c);
  state.i++;
}

function scanQuoted(state: ScanState, quote: '"' | "'"): void {
  const c = current(state);
  if (c === "\n") {
    state.mode = "code";
    state.out.push("\n");
    state.i++;
    return;
  }
  if (c === "\\") {
    blankEscapedPair(state);
    return;
  }
  if (c === quote) {
    state.mode = "code";
    state.out.push(c);
    state.i++;
    return;
  }
  blank(state, c);
  state.i++;
}

function scanTemplate(state: ScanState): void {
  const c = current(state);
  if (c === "\\") {
    blankEscapedPair(state);
    return;
  }
  if (c === "`") {
    state.mode = "code";
    state.out.push(c);
    state.i++;
    return;
  }
  blank(state, c);
  state.i++;
}

function blankEscapedPair(state: ScanState): void {
  blank(state, current(state));
  if (state.i + 1 < state.src.length) blank(state, state.src[state.i + 1]!);
  state.i += 2;
}

const DECL_PATTERNS: RegExp[] = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/,
];

function duplicateDeclarations(skeleton: string): string[] {
  const seen = new Map<string, number>();
  for (const line of skeleton.split("\n")) {
    if (line === "" || /^\s/.test(line)) continue;
    for (const re of DECL_PATTERNS) {
      const m = re.exec(line);
      if (m?.[1]) {
        seen.set(m[1], (seen.get(m[1]) || 0) + 1);
        break;
      }
    }
  }
  return [...seen.entries()].filter(([, count]) => count >= 2).map(([name]) => name);
}

export function checkBuildSanity(files: Map<string, string>): SanityFinding[] {
  const findings: SanityFinding[] = [];

  for (const [path, content] of files) {
    if (!SRC_RE.test(path)) continue;

    const skeleton = stripToSkeleton(content);
    const dups = duplicateDeclarations(skeleton);
    if (dups.length) {
      findings.push({
        file: path,
        problem:
          `duplicate top-level declaration(s): ${dups.join(", ")}. ` +
          `Each name is defined more than once at the top of the file; esbuild fails with ` +
          `"The symbol has already been declared". You likely appended a new version of the ` +
          `code instead of replacing the old one. Remove the duplicate block so each is defined once.`,
      });
    }

    const defaults = (skeleton.match(/^export\s+default\b/gm) || []).length;
    if (defaults >= 2) {
      findings.push({
        file: path,
        problem: `${defaults} \`export default\` statements; a module may have only one.`,
      });
    }
  }

  return findings;
}

export function formatSanityBlock(findings: SanityFinding[], noun: string): string {
  const lines = findings.map((f) => `  - ${f.file}: ${f.problem}`);
  return (
    `Deploy BLOCKED: your ${noun}'s code will not build, so shipping it now would fail CI ` +
    `and leave the old version live. Fix these, then deploy again:\n\n${lines.join("\n")}\n\n` +
    `When changing an existing file, rewrite the whole file in one write_file call. ` +
    `Do not append a second copy of a function, component, or import.`
  );
}

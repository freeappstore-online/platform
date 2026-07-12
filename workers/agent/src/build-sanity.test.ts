import { describe, expect, it } from "vitest";
import { checkBuildSanity, stripToSkeleton } from "./build-sanity";

const f = (path: string, content: string) => new Map([[path, content]]);

describe("stripToSkeleton", () => {
  it("hides comments and template bodies without removing real top-level code", () => {
    const skeleton = stripToSkeleton(`// function ghost() {}\nconst tpl = \`\nfunction fake() {}\n\`;\nconst real = 1;`);
    expect(skeleton).not.toContain("ghost");
    expect(skeleton).not.toContain("fake");
    expect(skeleton).toContain("const real");
  });

  it("does not let a JSX apostrophe swallow following lines", () => {
    const skeleton = stripToSkeleton(`<h1>Don't stop</h1>\nconst score = 1;`);
    expect(skeleton).toContain("const score");
  });

  it("preserves line structure for column-zero checks", () => {
    const skeleton = stripToSkeleton("const a = 1;\n  const b = 2;\nfunction c() {}");
    expect(skeleton.split("\n")).toHaveLength(3);
    expect(/^const a/m.test(skeleton)).toBe(true);
    expect(/^\s+const b/m.test(skeleton)).toBe(true);
  });
});

describe("checkBuildSanity", () => {
  it("flags duplicated top-level functions", () => {
    const findings = checkBuildSanity(
      f("web/src/App.tsx", `function draw() {}\nfunction lerp() {}\n\nfunction draw() {}\nfunction lerp() {}`),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toContain("draw");
    expect(findings[0]!.problem).toContain("lerp");
  });

  it("flags duplicated top-level consts and classes", () => {
    const findings = checkBuildSanity(f("web/src/game.ts", "const GRAVITY = 9.8;\nclass Player {}\nconst GRAVITY = 1;\nclass Player {}"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toContain("GRAVITY");
    expect(findings[0]!.problem).toContain("Player");
  });

  it("flags multiple default exports", () => {
    const findings = checkBuildSanity(f("web/src/App.tsx", "export default function A() {}\nexport default function B() {}"));
    expect(findings.some((finding) => finding.problem.includes("export default"))).toBe(true);
  });

  it("does not flag same local names in different scopes", () => {
    const src = `function a() {
  const x = 1;
  return x;
}
function b() {
  const x = 2;
  return x;
}`;
    expect(checkBuildSanity(f("web/src/App.tsx", src))).toEqual([]);
  });

  it("does not flag code-looking text inside comments, strings, or templates", () => {
    const src = `const draw = () => {};
// function draw() {}
const note = "function draw() {}";
const tpl = \`
function draw() {}
\`;`;
    expect(checkBuildSanity(f("web/src/App.tsx", src))).toEqual([]);
  });

  it("passes common React/JSX patterns with apostrophes, regex, generics, and division", () => {
    const src = `import { useState } from "react";

const TILE = 32;
type Cell = { x: number; y: number };
const clean = (s: string) => s.replace(/[^a-z{}]/gi, "");

function neighbors<T extends Cell>(cell: T): Cell[] {
  return [{ x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y }];
}

export default function App() {
  const [score, setScore] = useState(0);
  const rate = score / (TILE || 1);
  return (
    <main>
      <h1>Don't stop - you're winning!</h1>
      <p>It's {neighbors({ x: 0, y: 0 } as Cell).length} moves, rate {rate}</p>
      {score > 0 && <span>Player's best: {clean("a{b}")}</span>}
      <button onClick={() => setScore((s) => s + 1)}>+1</button>
    </main>
  );
}`;
    expect(checkBuildSanity(f("web/src/App.tsx", src))).toEqual([]);
  });

  it("only inspects Vite-compiled web/src source files", () => {
    const files = new Map([
      ["scripts/tool.ts", "const X = 1;\nconst X = 2;"],
      ["README.md", "function foo() {}\nfunction foo() {}"],
    ]);
    expect(checkBuildSanity(files)).toEqual([]);
  });
});

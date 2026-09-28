// #91: an AI building an app over the MCP learns, from MCP output alone, to wrap
// the app in the SDK Shell with real nav items and to use the SDK components.
// These play the role of create-app evals: guidance that allows a nav-less app
// is the failure being fixed.

import { describe, expect, it } from "vitest";
import { BUILD_HANDOFF_BLOCK, getSdkReference, SDK_REFERENCE_FEATURES, withBuildHandoff } from "./sdk-reference";

// The Worker tsconfig has no Node types; load node:fs untyped (tests run in Node).
const fsModule = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync: (path: URL, encoding: "utf8") => string;
};
const here = (import.meta as ImportMeta & { url: string }).url;
const read = (path: string) => readFileSync(new URL(path, here), "utf8");

/** Guidance that builds on the Shell with navigation, as opposed to a bare frame or hand-rolled chrome. */
function teachesShellWithNav(text: string): boolean {
  return (
    /<Shell app=\{fas\}[^>]*\bnav=\{/.test(text) &&
    text.includes('<nav aria-label="Main">') &&
    /@freeappstore\/sdk\/ui/.test(text) &&
    !/from ["']\.\/components\/Shell["']/.test(text)
  );
}

/** Value exports of the SDK's UI entry, read from source so the reference can't drift from it. */
function sdkUiExports(): string[] {
  const src = read("../../../packages/sdk/src/ui/index.ts");
  const names: string[] = [];
  for (const [, block] of src.matchAll(/^export \{([^}]+)\} from/gm)) {
    for (const part of block.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("the build hand-off (every create-app path returns it)", () => {
  it("makes wrapping the app in Shell with nav items the first step", () => {
    expect(teachesShellWithNav(BUILD_HANDOFF_BLOCK)).toBe(true);
    expect(BUILD_HANDOFF_BLOCK).toMatch(/^1\. Wrap the whole app in `<Shell>`/m);
    expect(BUILD_HANDOFF_BLOCK).toContain("PageHeader");
    expect(BUILD_HANDOFF_BLOCK).toMatch(/never put navigation inside a screen/i);
  });

  it("says FreeAppStore has no paid tier and keeps requireAuth off by default", () => {
    expect(BUILD_HANDOFF_BLOCK).toMatch(/no subscription, paywall or upgrade screen/);
    expect(BUILD_HANDOFF_BLOCK).toMatch(/Leave `requireAuth` off/);
  });

  it("the checker rejects guidance without nav, and a local shell", () => {
    expect(teachesShellWithNav('<FasShell app={fas} appName="My App" requireAuth>{children}</FasShell> from "@freeappstore/sdk/ui"')).toBe(false);
    expect(teachesShellWithNav('<Shell app={fas} appName="My App">…</Shell> <nav aria-label="Main"> @freeappstore/sdk/ui')).toBe(false);
    expect(teachesShellWithNav('import { Shell } from "./components/Shell"; <Shell app={fas} nav={NAV}> <nav aria-label="Main">')).toBe(false);
  });
});

describe("sdk_reference", () => {
  it("the default and 'all' output lead with shell, then components", () => {
    for (const out of [getSdkReference(), getSdkReference("all")]) {
      const shell = out.indexOf("## Shell: the standard app frame");
      const components = out.indexOf("## Components (@freeappstore/sdk/ui)");
      expect(shell).toBeGreaterThan(-1);
      expect(components).toBeGreaterThan(shell);
      expect(out.indexOf("## Auth")).toBeGreaterThan(components);
    }
    expect(SDK_REFERENCE_FEATURES.slice(0, 2)).toEqual(["shell", "components"]);
  });

  it("'shell' is a complete app that wraps everything in Shell with nav before any screen", () => {
    const shell = getSdkReference("shell");
    expect(teachesShellWithNav(shell)).toBe(true);
    expect(shell).toMatch(/import \{[^}]*\bShell\b[^}]*\} from '@freeappstore\/sdk\/ui'/);
    expect(shell).toMatch(/const NAV: NavItem\[\] = \[/);
    // The Shell (with nav) is the root, and screens render inside it.
    const root = shell.indexOf("<Shell app={fas} appName=");
    expect(root).toBeGreaterThan(-1);
    expect(root).toBeLessThan(shell.indexOf("function Tags()"));
    expect(shell).toMatch(/<Shell app=\{fas\} appName="\w+" nav=\{NAV\} onNavigate=\{navigate\}>/);
    expect(shell).not.toMatch(/<Shell[^>]*requireAuth/);
  });

  it("'shell' answers how to add navigation and covers the resilience layer and props", () => {
    const shell = getSdkReference("shell");
    expect(shell).toContain("### How do I add navigation?");
    for (const term of ["onNavigate", "renderNav", "PageHeader", "useToast", "useDocumentTitle", "useOnline", "renderError", "renderLoading", "requireAuth"]) {
      expect(shell, term).toContain(term);
    }
    expect(shell).toMatch(/no paid tier, subscription or upgrade screen/);
  });

  it("'components' lists every export of @freeappstore/sdk/ui", () => {
    const exports = sdkUiExports();
    expect(exports).toEqual(expect.arrayContaining(["Shell", "FasShell", "NavBar", "PageHeader", "useToast"]));
    const components = getSdkReference("components");
    expect(exports.filter((name) => !components.includes(`\`${name}`))).toEqual([]);
  });

  it("the 'ui' import only names real exports, and shows Shell with nav instead of requireAuth", () => {
    const ui = getSdkReference("ui");
    const block = /import \{([^}]+)\} from '@freeappstore\/sdk\/ui'/.exec(ui)?.[1] ?? "";
    const imported = block.split(",").map((n) => n.trim()).filter(Boolean);
    const exports = new Set(sdkUiExports());
    expect(imported.filter((n) => !exports.has(n))).toEqual([]);
    expect(ui).toMatch(/<Shell app=\{fas\} appName="My App" nav=\{NAV\}/);
    expect(ui).not.toContain("requireAuth");
  });

  it("'hooks' covers the screen helpers", () => {
    const hooks = getSdkReference("hooks");
    for (const hook of ["useToast", "useDocumentTitle", "useOnline"]) expect(hooks).toContain(hook);
  });

  it("an unknown feature says so", () => {
    expect(getSdkReference("nope")).toContain("Unknown feature: nope");
  });
});

describe("platform_guide", () => {
  it("appends the build hand-off after the fetched guide, overriding older shell guidance", () => {
    const out = withBuildHandoff("# Old guide\nUse components/Shell.tsx");
    expect(out.startsWith("# Old guide")).toBe(true);
    expect(out.indexOf(BUILD_HANDOFF_BLOCK)).toBeGreaterThan(out.indexOf("components/Shell.tsx"));
    expect(out).toMatch(/supersede any older shell\/layout guidance/);
  });
});

describe("the MCP tools return the hand-off (pinned in index.ts)", () => {
  const index = read("./index.ts");
  const tool = (name: string) => {
    const start = index.indexOf(`"${name}",`);
    const next = index.indexOf("this.server.tool(", start);
    return index.slice(start, next === -1 ? undefined : next);
  };

  it("create_app ends both its dry-run plan and its result with the hand-off", () => {
    const createApp = tool("create_app");
    expect(createApp.match(/\$\{BUILD_HANDOFF_BLOCK\}`/g)).toHaveLength(2);
    expect(createApp).toMatch(/Build: wrap web\/src\/App\.tsx in <Shell app=\{fas\} nav=\{NAV\}>/);
    expect(createApp).toMatch(/build it out on the SDK Shell with a nav item per screen/);
  });

  it("platform_guide wraps both the fetched guide and the failure path with the hand-off", () => {
    expect(tool("platform_guide").match(/withBuildHandoff\(/g)).toHaveLength(2);
  });

  it("sdk_reference serves getSdkReference and tells callers to start with shell", () => {
    const ref = tool("sdk_reference");
    expect(ref).toContain("getSdkReference(feature)");
    expect(ref).toContain("...SDK_REFERENCE_FEATURES");
    expect(ref).toMatch(/Start with feature \\"shell\\"/);
  });
});

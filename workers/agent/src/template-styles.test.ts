import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getConfig } from "./config";
import { APP_ARCHETYPES, getTemplateFiles } from "./template";

describe("Builder SDK stylesheet contract (#373)", () => {
  const docs = readFileSync(new URL("../../../docs/ui.md", import.meta.url), "utf8");
  const start = docs.indexOf('@import "tailwindcss";', docs.indexOf("SDK 0.16.0 no longer"));
  const contract = docs.slice(start, docs.indexOf("```", start)).trim();
  for (const preset of ["standalone", "connected"] as const) {
    for (const archetype of APP_ARCHETYPES) {
      it(`${preset}/${archetype} includes the CLI's documented source, token and animation contract`, () => {
        const css = getTemplateFiles(getConfig("apps"), archetype, preset)["web/src/index.css"];
        // The CLI can supply fallback values; the builder defines its own theme.
        // Compare the source directives, token bindings and animations separately.
        for (const [directive] of contract.matchAll(/@(?:import|source)[^;]+;/g)) {
          expect(css).toContain(directive);
        }
        for (const [, name, token] of contract.matchAll(/(--[\w-]+): var\((--[\w-]+)/g)) {
          expect(css).toMatch(new RegExp(`${name}: var\\(${token}(?:,|\\))`));
        }
        expect(css.replace(/\r\n/g, "\n")).toContain(contract.slice(contract.indexOf("@theme {")).replace(/\r\n/g, "\n"));
        // Every mapped SDK token has an app-owned value, including floating surfaces.
        for (const [, token] of contract.matchAll(/var\(--([\w-]+)/g)) {
          expect(css.slice(css.indexOf(":root {")), token).toMatch(new RegExp(`--${token}:\\s*[^;]+;`));
        }
        expect(css).toContain("--popover: var(--paper)");
        expect(css).toContain(':root[data-text="lg"] { font-size: 112.5%; }');
      });
    }
  }
});

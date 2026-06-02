import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("Security: no secrets in source", () => {
  const srcDir = join(__dirname, "..");
  const files = readdirSync(srcDir, { recursive: true }) as string[];
  const tsFiles = files.filter((f) => f.endsWith(".ts") && !f.includes("test/") && !f.includes("node_modules"));

  // Known patterns that should NEVER appear in source
  const forbidden = [
    /cfk_[A-Za-z0-9]{30,}/, // CF Global API Key
    /cfut_[A-Za-z0-9]{30,}/, // CF API Token
    /ghp_[A-Za-z0-9]{30,}/, // GitHub PAT
    /gho_[A-Za-z0-9]{30,}/, // GitHub OAuth token
    /662a28f8ee2476/, // Old leaked service token secret
    /serge\.the\.dev@gmail\.com/, // Email in source (should be in secrets)
  ];

  for (const file of tsFiles) {
    it(`${file} has no hardcoded secrets`, () => {
      const content = readFileSync(join(srcDir, file), "utf-8");
      for (const pattern of forbidden) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});

describe("Security: SKILLS.md has no secrets", () => {
  it("no service tokens in public docs", async () => {
    const res = await fetch("https://raw.githubusercontent.com/freeappstore-online/freeappstore/main/SKILLS.md");
    const text = await res.text();
    expect(text).not.toMatch(/CF-Access-Client-Secret/);
    expect(text).not.toMatch(/cfk_/);
    expect(text).not.toMatch(/cfut_/);
    expect(text).not.toMatch(/662a28f8/);
  });
});

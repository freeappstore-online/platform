import { describe, expect, it } from "vitest";
import { getConfig } from "./config";
import { getArchetypeFiles, getSystemPrompt, getTemplateFiles } from "./template";

const appsConfig = getConfig("apps");
const gamesConfig = getConfig("games");

describe("getTemplateFiles", () => {
  const appsFiles = getTemplateFiles(appsConfig);
  const gamesFiles = getTemplateFiles(gamesConfig);

  it("apps template has Shell.tsx, not GameShell.tsx", () => {
    expect(appsFiles).toHaveProperty("web/src/components/Shell.tsx");
    expect(appsFiles).not.toHaveProperty("web/src/components/GameShell.tsx");
  });

  it("games template has GameShell.tsx, not Shell.tsx", () => {
    expect(gamesFiles).toHaveProperty("web/src/components/GameShell.tsx");
    expect(gamesFiles).not.toHaveProperty("web/src/components/Shell.tsx");
  });

  it("apps template uses --paper CSS variable", () => {
    expect(appsFiles["web/src/index.css"]).toContain("--paper");
  });

  it("games template uses --bg CSS variable", () => {
    expect(gamesFiles["web/src/index.css"]).toContain("--bg");
  });

  it("apps template has light/dark theme", () => {
    expect(appsFiles["web/src/index.css"]).toContain("prefers-color-scheme: dark");
  });

  it("games template has overflow: hidden", () => {
    expect(gamesFiles["web/src/index.css"]).toContain("overflow: hidden");
  });

  it("apps theme color is blue", () => {
    expect(appsFiles["web/index.html"]).toContain("#2563eb");
    expect(appsFiles["web/public/manifest.json"]).toContain("#2563eb");
  });

  it("games theme color is green", () => {
    expect(gamesFiles["web/index.html"]).toContain("#10b981");
    expect(gamesFiles["web/public/manifest.json"]).toContain("#10b981");
  });

  it("apps title references FreeAppStore", () => {
    expect(appsFiles["web/index.html"]).toContain("FreeAppStore");
  });

  it("games title references FreeGameStore", () => {
    expect(gamesFiles["web/index.html"]).toContain("FreeGameStore");
  });

  it("apps Shell links to freeappstore.online", () => {
    expect(appsFiles["web/src/components/Shell.tsx"]).toContain("freeappstore.online");
  });

  it("games GameShell links to freegamestore.online", () => {
    expect(gamesFiles["web/src/components/GameShell.tsx"]).toContain("freegamestore.online");
  });

  it("apps LICENSE says FreeAppStore", () => {
    expect(appsFiles.LICENSE).toContain("FreeAppStore");
  });

  it("games LICENSE says FreeGameStore", () => {
    expect(gamesFiles.LICENSE).toContain("FreeGameStore");
  });

  it("shared files are identical between stores", () => {
    const sharedPaths = [
      "pnpm-workspace.yaml",
      "package.json",
      "web/package.json",
      "web/vite.config.ts",
      "web/tsconfig.json",
      "web/tsconfig.app.json",
      "web/tsconfig.node.json",
      "web/src/main.tsx",
      ".gitignore",
    ];
    for (const p of sharedPaths) {
      expect(appsFiles[p]).toBe(gamesFiles[p]);
    }
  });

  it("both templates have a reasonable number of files", () => {
    expect(Object.keys(appsFiles).length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(gamesFiles).length).toBeGreaterThanOrEqual(15);
  });

  it("apps template includes dashboard archetype files", () => {
    const files = getTemplateFiles(appsConfig, "dashboard");
    expect(files).toHaveProperty("web/src/components/Dashboard.tsx");
  });

  it("apps template includes tracker archetype files", () => {
    const files = getTemplateFiles(appsConfig, "tracker");
    expect(files).toHaveProperty("web/src/components/Tracker.tsx");
  });

  it("apps template includes calculator archetype files", () => {
    const files = getTemplateFiles(appsConfig, "calculator");
    expect(files).toHaveProperty("web/src/components/Calculator.tsx");
  });

  it("apps template works unchanged without an archetype", () => {
    const files = getTemplateFiles(appsConfig);
    expect(files).toEqual(appsFiles);
    expect(files).not.toHaveProperty("web/src/components/Dashboard.tsx");
    expect(files).not.toHaveProperty("web/src/components/Tracker.tsx");
    expect(files).not.toHaveProperty("web/src/components/Calculator.tsx");
  });
});

describe("getArchetypeFiles", () => {
  it("dashboard returns Dashboard component files", () => {
    const files = getArchetypeFiles("dashboard");
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(Object.keys(files).some((path) => path.includes("Dashboard"))).toBe(true);
  });

  it("tracker returns Tracker component files", () => {
    const files = getArchetypeFiles("tracker");
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(Object.keys(files).some((path) => path.includes("Tracker"))).toBe(true);
  });

  it("calculator returns Calculator component files", () => {
    const files = getArchetypeFiles("calculator");
    expect(Object.keys(files).length).toBeGreaterThan(0);
    expect(Object.keys(files).some((path) => path.includes("Calculator"))).toBe(true);
  });

  it("generic returns no extra files", () => {
    expect(getArchetypeFiles("generic")).toEqual({});
  });
});

describe("getSystemPrompt", () => {
  it("apps prompt mentions FreeAppStore", () => {
    const prompt = getSystemPrompt(appsConfig);
    expect(prompt).toContain("FreeAppStore");
    expect(prompt).not.toContain("FreeGameStore");
  });

  it("games prompt mentions FreeGameStore", () => {
    const prompt = getSystemPrompt(gamesConfig);
    expect(prompt).toContain("FreeGameStore");
    expect(prompt).not.toContain("FreeAppStore");
  });

  it("apps prompt references Shell component", () => {
    expect(getSystemPrompt(appsConfig)).toContain("Shell");
  });

  it("games prompt references GameShell component", () => {
    expect(getSystemPrompt(gamesConfig)).toContain("GameShell");
  });

  it("apps prompt references list_deployed_apps", () => {
    expect(getSystemPrompt(appsConfig)).toContain("list_deployed_apps");
  });

  it("games prompt references list_deployed_games", () => {
    expect(getSystemPrompt(gamesConfig)).toContain("list_deployed_games");
  });

  it("games prompt has game-specific rules", () => {
    const prompt = getSystemPrompt(gamesConfig);
    expect(prompt).toContain("requestAnimationFrame");
    expect(prompt).toContain("overflow: hidden");
    expect(prompt).toContain("Canvas");
  });

  it("apps prompt has app-specific rules", () => {
    const prompt = getSystemPrompt(appsConfig);
    expect(prompt).toContain("localStorage");
    expect(prompt).toContain("Dark mode");
    expect(prompt).toContain("sidebar");
  });
});

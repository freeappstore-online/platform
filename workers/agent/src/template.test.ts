import { describe, expect, it } from "vitest";
import { runComplianceCheck } from "./compliance";
import { getConfig } from "./config";
import { APP_ARCHETYPES, getArchetypeFiles, getSystemPrompt, getTemplateFiles, substituteAppName } from "./template";

const appsConfig = getConfig("apps");
const gamesConfig = getConfig("games");

describe("getTemplateFiles", () => {
  const appsFiles = getTemplateFiles(appsConfig);
  const gamesFiles = getTemplateFiles(gamesConfig);

  it("apps template has no local shell component: it uses the SDK Shell (#90)", () => {
    expect(appsFiles).not.toHaveProperty("web/src/components/Shell.tsx");
    expect(appsFiles).not.toHaveProperty("web/src/components/GameShell.tsx");
  });

  it("games template has GameShell.tsx, not Shell.tsx", () => {
    expect(gamesFiles).toHaveProperty("web/src/components/GameShell.tsx");
    expect(gamesFiles).not.toHaveProperty("web/src/components/Shell.tsx");
  });

  it("apps template uses --paper CSS variable", () => {
    expect(appsFiles["web/src/index.css"]).toContain("--paper");
  });

  it("games template uses --paper, never the banned --bg alias (#64)", () => {
    expect(gamesFiles["web/src/index.css"]).toContain("--paper:");
    const banned = /var\(--bg\)|--bg\s*:/;
    expect(gamesFiles["web/src/index.css"]).not.toMatch(banned);
    expect(gamesFiles["web/src/components/GameShell.tsx"]).not.toMatch(banned);
  });

  it("apps template's dark theme follows the SDK's data-theme (system default + Shell toggle)", () => {
    expect(appsFiles["web/src/index.css"]).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*color-scheme: dark/);
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

  it("apps starter links to freeappstore.online", () => {
    expect(appsFiles["web/src/App.tsx"]).toContain("freeappstore.online");
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

  it("apps prompt teaches the SDK Shell as the standard path (#90)", () => {
    const prompt = getSystemPrompt(appsConfig);
    for (const term of ["<Shell>", '"@freeappstore/sdk/ui"', "NAV", "PageHeader", "useToast", "useDocumentTitle", "no paid tier"]) {
      expect(prompt).toContain(term);
    }
    expect(prompt).not.toContain("Shell.tsx");
    expect(prompt).not.toMatch(/sidebar \(17rem\)|Shell sidebar|prefers-color-scheme/);
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
  });
});

describe("apps scaffold: the SDK Shell with real navigation from first render (#90)", () => {
  const files = getTemplateFiles(appsConfig);
  const app = files["web/src/App.tsx"]!;

  it("App.tsx wraps the app in Shell from @freeappstore/sdk/ui, not a local component", () => {
    expect(app).toMatch(/import \{[^}]*\bShell\b[^}]*\} from "@freeappstore\/sdk\/ui"/);
    expect(app).toMatch(/const fas = initApp\(\{ appId: "APPID" \}\)/);
    expect(app).toMatch(/<Shell app=\{fas\} appName="APPNAME" nav=\{NAV\} onNavigate=\{navigate\}>/);
    expect(app).not.toMatch(/from "\.\/components\/Shell"/);
  });

  it("declares real nav items, each with a screen App renders", () => {
    const hrefs = [...app.matchAll(/\{ label: "[^"]+", href: "([^"]+)", title: "[^"]+" \}/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/", "/about"]);
    expect(app).toContain('path === "/about" ? <About /> : <Home />');
    // Client-side routing follows back/forward.
    expect(app).toContain('addEventListener("popstate"');
    expect(app).toContain("history.pushState");
  });

  it("each starter screen opens with PageHeader (its single h1)", () => {
    expect(app.match(/<PageHeader /g)).toHaveLength(2);
    expect(app).not.toMatch(/<h1\b/);
  });

  it("depends on an SDK with the navbar and resilience layer (>= 0.14.30)", () => {
    const range = JSON.parse(files["web/package.json"]!).dependencies["@freeappstore/sdk"] as string;
    const [major, minor, patch] = range.replace(/^\^/, "").split(".").map(Number);
    expect(major).toBe(0);
    expect(minor).toBe(14);
    expect(patch).toBeGreaterThanOrEqual(30);
  });

  it("applies Fraunces to headings", () => {
    expect(files["web/src/index.css"]).toMatch(/--font-display: "Fraunces"/);
    expect(files["web/src/index.css"]).toMatch(/h1,\s*h2,\s*h3\s*\{\s*font-family: var\(--font-display\)/);
  });

  it("a freshly scaffolded app passes the agent's compliance check, for every archetype", () => {
    for (const archetype of APP_ARCHETYPES) {
      const scaffold = substituteAppName(getTemplateFiles(appsConfig, archetype), "my-app", "My App");
      const output = runComplianceCheck(new Map(Object.entries(scaffold)), appsConfig);
      expect(output, archetype).not.toContain("FAIL");
    }
  });
});

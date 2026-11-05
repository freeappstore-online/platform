import { describe, expect, it } from "vitest";
import { runComplianceCheck } from "./compliance";
import { getConfig } from "./config";
import {
  APP_ARCHETYPES,
  applyCapabilitiesToTemplate,
  getArchetypeFiles,
  getSystemPrompt,
  getTemplateFiles,
  substituteAppName,
} from "./template";

const appsConfig = getConfig("apps");
const gamesConfig = getConfig("games");

describe("getTemplateFiles", () => {
  const appsFiles = getTemplateFiles(appsConfig);
  const gamesFiles = getTemplateFiles(gamesConfig);

  it("uses one declared target for the apps build, verification and upload", () => {
    const files = substituteAppName(appsFiles, "weather-app", "Weather App");
    expect(JSON.parse(files["fas.json"])).toEqual({
      appId: "weather-app",
      applicationRoot: "web",
      outputPath: "web/dist",
      buildCommand: "pnpm build",
    });
    const workflow = files[".github/workflows/deploy.yml"];
    expect(workflow).toContain('build-target --app-id "${GITHUB_REPOSITORY##*/}" --github-output');
    expect(workflow).toContain("build-target --artifact");
    expect(workflow).toContain('aws s3 sync "$OUTPUT_PATH"');
    expect(JSON.parse(files["package.json"]).scripts.typecheck).toBe("pnpm --filter @weather-app/web exec tsc -b");
    expect(workflow).toContain("run: pnpm run --if-present typecheck");
    expect(workflow.indexOf("Typecheck (when configured)")).toBeLessThan(workflow.indexOf("- name: Build"));
  });

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

  it("shares foundation files and keeps valid store-specific test scripts", () => {
    const sharedPaths = ["pnpm-workspace.yaml", "web/tsconfig.json", "web/tsconfig.app.json", "web/tsconfig.node.json", ".gitignore"];
    for (const p of sharedPaths) {
      expect(appsFiles[p]).toBe(gamesFiles[p]);
    }
    const appPackage = JSON.parse(appsFiles["package.json"]!) as { scripts: Record<string, string> };
    const gamePackage = JSON.parse(gamesFiles["package.json"]!) as { scripts: Record<string, string> };
    expect({ ...appPackage, scripts: { ...appPackage.scripts, test: undefined } }).toEqual({
      ...gamePackage,
      scripts: { ...gamePackage.scripts, test: undefined },
    });
    expect(appPackage.scripts.test).toBe("pnpm --filter @APPNAME/web test");
    expect(gamePackage.scripts.test).toBe("pnpm build");
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

  it("generates the connected preset from the shared resolver and #350 app-owned draft wiring", () => {
    for (const archetype of APP_ARCHETYPES) {
      const files = getTemplateFiles(appsConfig, archetype, "connected");
      const app = files["web/src/App.tsx"];
      const draft = files["web/src/components/ConnectedDraft.tsx"];
      expect(files["web/package.json"]).toContain('"@freeappstore/sdk": "^0.16.37"');
      expect(files["fas-capabilities/cloud-data.md"]).toContain("Room-restricted");
      expect(draft).toContain("useConnectedKvDraft");
      expect(draft).toContain("draft.retry");
      expect(draft).toContain("app: FreeAppStore");
      expect(draft).not.toContain("initApp(");
      expect(draft).toContain("pwa.addBusyGuard(() => busy.current)");
      expect(app).not.toContain("requireAuth");
      expect(app).toContain("<ConnectedDraft app={fas} />");
      expect(app).toContain("Editable app-owned starter screen");
      expect(app.match(/initApp\(/g)).toHaveLength(1);
    }
  });

  it("keeps standalone builder generation on the same canonical PWA resolver", () => {
    const files = getTemplateFiles(appsConfig, "generic", "standalone");
    expect(files["web/src/fas-capabilities/pwa.ts"]).toContain("@freeappstore/sdk/pwa");
    expect(files["web/src/pwa.ts"]).toContain("export { pwa } from './fas-capabilities/pwa'");
    expect(files["web/src/pwa.ts"]).not.toContain("startPwa");
    expect(files["web/src/main.tsx"]).toContain("import './fas-capabilities/pwa'");
    expect(files["fas-capabilities/pwa.md"]).toContain("addBusyGuard");
    expect(files["web/src/App.tsx"]).not.toContain("requireAuth");
  });

  it("supports shared dry-run, prerequisite rejection, apply, and conflict behavior for later builder adds", async () => {
    const scaffold = getTemplateFiles(appsConfig);
    const preview = await applyCapabilitiesToTemplate(scaffold, ["connectivity"], true);
    expect(preview.changes.join("\n")).toContain("CREATE fas-capabilities/connectivity.ts");
    expect(preview.files).not.toHaveProperty("fas-capabilities/connectivity.ts");
    const applied = await applyCapabilitiesToTemplate(scaffold, ["connectivity"]);
    expect(applied.files["fas-capabilities/connectivity.ts"]).toContain("watchConnectivity");
    expect((await applyCapabilitiesToTemplate(applied.files, ["connectivity"])).changes).toContain("No changes.");
    const edited = { ...applied.files, "fas-capabilities/connectivity.ts": "custom" };
    await expect(applyCapabilitiesToTemplate(edited, ["connectivity"])).rejects.toThrow("conflict");

    const installed = JSON.parse(applied.files[".fas-capabilities.json"]!);
    installed.capabilities.connectivity.version = "0.9.0";
    const older = { ...applied.files, ".fas-capabilities.json": JSON.stringify(installed) };
    await expect(applyCapabilitiesToTemplate(older, ["connectivity"])).rejects.toThrow("review a dry-run");
    const updated = await applyCapabilitiesToTemplate(older, ["connectivity"], false, true);
    expect(JSON.parse(updated.files[".fas-capabilities.json"]!).capabilities.connectivity.version).toBe("1.0.0");

    const oldSdk = {
      ...scaffold,
      "package.json": JSON.stringify({ dependencies: { "@freeappstore/sdk": "0.16.14" } }),
    };
    const rejected = await applyCapabilitiesToTemplate(oldSdk, ["persistence"], true);
    expect(rejected.prerequisites.join("\n")).toContain("requires @freeappstore/sdk >=0.16.18");
    expect(rejected.files).not.toHaveProperty("fas-capabilities/persistence.ts");
    await expect(applyCapabilitiesToTemplate(oldSdk, ["persistence"])).rejects.toThrow("no files changed");

    const webOnlySdk = {
      ...scaffold,
      "package.json": JSON.stringify({ dependencies: {} }),
      "web/package.json": JSON.stringify({ dependencies: { "@freeappstore/sdk": "^0.16.26" } }),
    };
    const rootPrerequisite = await applyCapabilitiesToTemplate(webOnlySdk, ["persistence"], true);
    expect(rootPrerequisite.prerequisites.join("\n")).toContain("package.json");
    expect(rootPrerequisite.files).not.toHaveProperty("fas-capabilities/persistence.ts");

    const rootSdkOldWeb = {
      ...scaffold,
      "package.json": JSON.stringify({ dependencies: { "@freeappstore/sdk": "^0.16.26" } }),
      "web/package.json": JSON.stringify({ dependencies: { "@freeappstore/sdk": "0.14.30" } }),
    };
    await expect(applyCapabilitiesToTemplate(rootSdkOldWeb, ["persistence"])).resolves.toBeTruthy();

    const rootOnlyPwa = {
      ...scaffold,
      "package.json": JSON.stringify({
        dependencies: { "@freeappstore/sdk": "^0.16.32" },
        devDependencies: { "vite-plugin-pwa": "^1.3.0" },
      }),
    };
    delete rootOnlyPwa["web/package.json"];
    const rootOnlyPreview = await applyCapabilitiesToTemplate(rootOnlyPwa, ["pwa"], true);
    expect(rootOnlyPreview.prerequisites).toEqual([]);
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

  it("both prompts forbid payments and ads, like fas check", () => {
    for (const config of [appsConfig, gamesConfig]) {
      const prompt = getSystemPrompt(config);
      expect(prompt).toContain("NO payments and NO ads");
      expect(prompt).toMatch(/Stripe[\s\S]*AdSense/);
      expect(prompt).toContain("Do NOT add analytics, tracking, payments, ads, or any third-party scripts.");
    }
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
    expect(app).toMatch(/<Shell app=\{fas\} appName=\{"APPNAME_JS"\} nav=\{NAV\} onNavigate=\{navigate\}>/);
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

  it("depends on the current shared SDK package line, including lifecycle helpers", () => {
    const range = JSON.parse(files["web/package.json"]!).dependencies["@freeappstore/sdk"] as string;
    const [major, minor, patch] = range.replace(/^\^/, "").split(".").map(Number);
    expect(major).toBe(0);
    expect(minor).toBe(16);
    expect(patch).toBeGreaterThanOrEqual(15);
  });

  it("wires the shared PWA runtime, safe config, install icons and zoom", () => {
    expect(files["web/vite.config.ts"]).toContain("VitePWA(pwaOptions())");
    expect(files["web/src/main.tsx"]).toContain("import './fas-capabilities/pwa'");
    expect(files["web/src/pwa.ts"]).toContain("export { pwa } from './fas-capabilities/pwa'");
    expect(files["web/src/pwa.ts"]).not.toContain("startPwa");
    expect(
      Object.values(files)
        .join("\n")
        .match(/startPwa\(/g),
    ).toHaveLength(1);
    expect(files["web/src/index.css"]).toContain('@source "../node_modules/@freeappstore/sdk/dist";');
    expect(files["web/src/index.css"]).toContain('@source "../../node_modules/@freeappstore/sdk/dist";');
    expect(files["web/src/index.css"]).toContain("@theme inline");
    expect(files["web/src/index.css"]).toContain("--color-popover: var(--popover");
    expect(JSON.parse(files["web/public/manifest.json"]!).icons[0].purpose).toContain("maskable");
    expect(files["web/public/icon.svg"]).toContain("viewBox");
    expect(files["web/index.html"]).not.toMatch(/user-scalable|maximum-scale/);
  });

  it("applies Fraunces to headings", () => {
    expect(files["web/src/index.css"]).toMatch(/--font-display: "Fraunces"/);
    expect(files["web/src/index.css"]).toMatch(/h1,\s*h2,\s*h3\s*\{\s*font-family: var\(--font-display\)/);
  });

  it("a freshly scaffolded app passes the agent's compliance check, for every archetype", async () => {
    for (const archetype of APP_ARCHETYPES) {
      const scaffold = substituteAppName(getTemplateFiles(appsConfig, archetype), "my-app", "My App");
      const output = await runComplianceCheck(new Map(Object.entries(scaffold)), appsConfig);
      expect(output, archetype).not.toContain("FAIL");
    }
  });
});

describe("connected preset (#368)", () => {
  it.each(APP_ARCHETYPES)("shares one app instance and gates only private data: %s", (archetype) => {
    const files = getTemplateFiles(appsConfig, archetype, "connected");
    const source = Object.values(files).join("\n");
    expect(source.match(/initApp\(/g)).toHaveLength(1);
    expect(files["web/src/App.tsx"]).toContain("<ConnectedDraft app={fas} />");
    expect(files["web/src/App.tsx"]).not.toContain("requireAuth");
    expect(files["web/src/components/ConnectedDraft.tsx"]).toContain("if (!draft.user)");
    expect(JSON.parse(files["web/package.json"]).dependencies["@freeappstore/sdk"]).toBe("^0.16.37");
  });

  it("does not change standalone or game templates", () => {
    expect(getTemplateFiles(appsConfig, "generic", "standalone")).toEqual(getTemplateFiles(appsConfig, "generic"));
    expect(getTemplateFiles(gamesConfig, "generic", "connected")).toEqual(getTemplateFiles(gamesConfig, "generic"));
  });
});

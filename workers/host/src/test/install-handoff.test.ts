import { describe, expect, it, vi } from "vitest";
import { INSTALL_SCRIPT, INSTALL_SCRIPT_PATH, INSTALL_SCRIPT_TAG, installScriptResponse, wantsInstall } from "../install-handoff";

describe("/.fas/install.js (#621)", () => {
  it("is static JavaScript with an hour's cache and the platform's security headers", async () => {
    const res = installScriptResponse("GET");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(INSTALL_SCRIPT);
  });

  it("answers HEAD without a body", async () => {
    const res = installScriptResponse("HEAD");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("refuses writes", () => {
    const res = installScriptResponse("POST");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("is injected as a same-origin deferred tag", () => {
    expect(INSTALL_SCRIPT_TAG).toBe(`<script src="${INSTALL_SCRIPT_PATH}" defer></script>`);
    expect(INSTALL_SCRIPT_PATH).toBe("/.fas/install.js");
  });

  it("is requested only by the exact install=1 parameter", () => {
    expect(wantsInstall(new URL("https://run.freeappstore.online/?install=1"))).toBe(true);
    expect(wantsInstall(new URL("https://run.freeappstore.online/?a=b&install=1"))).toBe(true);
    for (const q of ["", "?install", "?install=0", "?install=true", "?Install=1", "?install=1x"]) {
      expect(wantsInstall(new URL(`https://run.freeappstore.online/${q}`)), q).toBe(false);
    }
  });

  it("stays ES2019: no optional chaining or nullish coalescing", () => {
    expect(INSTALL_SCRIPT).not.toMatch(/\?\.|\?\?/);
    expect(() => new Function(INSTALL_SCRIPT)).not.toThrow();
  });
});

/** Runs the script against a minimal browser stand-in. */
function run(opts: { search: string; standalone?: boolean; promptApi?: boolean; manifest?: unknown }) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const location = { href: `https://run.freeappstore.online/${opts.search}`, origin: "https://run.freeappstore.online" };
  const history = { state: null, replaceState: vi.fn((_s: unknown, _t: string, href: string) => (location.href = href)) };
  const buttons: Record<string, { textContent: string; click?: () => void }> = {};
  const root = {
    innerHTML: "",
    querySelector: (sel: string) => {
      buttons[sel] ??= { textContent: "" };
      const b = buttons[sel];
      return {
        set textContent(v: string) {
          b.textContent = v;
        },
        addEventListener: (_: string, f: () => void) => (b.click = f),
      };
    },
  };
  const appended: { removed: boolean }[] = [];
  const document = {
    querySelector: () => (opts.manifest ? { href: "https://run.freeappstore.online/manifest.json" } : null),
    body: {
      appendChild: (el: { removed: boolean }) => appended.push(el),
    },
    createElement: () => {
      const el = { removed: false, attachShadow: () => root, remove: () => (el.removed = true) };
      return el;
    },
  };
  const window: Record<string, unknown> = opts.promptApi === false ? {} : { onbeforeinstallprompt: null };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => opts.manifest }));
  new Function("location", "history", "matchMedia", "navigator", "window", "document", "addEventListener", "fetch", INSTALL_SCRIPT)(
    location,
    history,
    () => ({ matches: !!opts.standalone }),
    {},
    window,
    document,
    (type: string, f: (e: unknown) => void) => (listeners[type] = f),
    fetch,
  );
  return { location, history, listeners, buttons, appended, fetch };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("install.js in the page", () => {
  it("removes install=1 from the address and shows the bar when the prompt is deferred", async () => {
    const page = run({ search: "?install=1&tab=2", manifest: { short_name: "Run" } });
    expect(page.location.href).toBe("https://run.freeappstore.online/?tab=2");
    const event = { preventDefault: vi.fn(), prompt: vi.fn(async () => {}), userChoice: Promise.resolve({ outcome: "accepted" }) };
    page.listeners.beforeinstallprompt(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await flush();
    expect(page.appended).toHaveLength(1);
    expect(page.buttons[".install"].textContent).toBe("Install Run");
    page.buttons[".install"].click!();
    await flush();
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(page.appended[0].removed).toBe(true);
  });

  it("falls back to 'Install app' without a manifest, and Not now removes the bar", async () => {
    const page = run({ search: "?install=1" });
    page.listeners.beforeinstallprompt({ preventDefault() {}, prompt() {}, userChoice: Promise.resolve() });
    await flush();
    expect(page.fetch).not.toHaveBeenCalled();
    expect(page.buttons[".install"].textContent).toBe("Install app");
    page.buttons[".later"].click!();
    expect(page.appended[0].removed).toBe(true);
  });

  it("does nothing beyond cleaning the address where there is no prompt API, or when already installed", () => {
    const safari = run({ search: "?install=1", promptApi: false });
    expect(safari.location.href).toBe("https://run.freeappstore.online/");
    expect(safari.listeners).toEqual({});
    const installed = run({ search: "?install=1", standalone: true });
    expect(installed.listeners).toEqual({});
  });
});

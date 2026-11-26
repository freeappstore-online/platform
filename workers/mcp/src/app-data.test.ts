import { describe, expect, it } from "vitest";
import {
  declaredCollection,
  fetchManifest,
  formatGuide,
  isDocId,
  MANIFEST_MAX_BYTES,
  parseManifest,
  stripMeta,
  validateDocument,
} from "./app-data.js";

const deckSchema = {
  type: "object",
  required: ["title", "slides"],
  properties: {
    title: { type: "string", minLength: 1 },
    slides: { type: "array", items: { type: "object", required: ["heading"], properties: { heading: { type: "string" } } } },
  },
  additionalProperties: false,
};
const manifest = {
  version: 1,
  instructions: "A slide deck editor.",
  collections: { decks: { description: "One document per presentation.", schema: deckSchema } },
};

function parsed(raw: unknown) {
  const result = parseManifest(JSON.stringify(raw));
  if ("error" in result) throw new Error(result.error);
  return result.manifest;
}

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    expect(parsed(manifest).collections.decks.description).toBe("One document per presentation.");
  });

  it.each([
    ["not JSON", "{", "not valid JSON"],
    ["an array", "[]", "must be a JSON object"],
    ["another version", JSON.stringify({ ...manifest, version: 2 }), "version must be 1"],
    ["missing instructions", JSON.stringify({ ...manifest, instructions: undefined }), "instructions must be a string"],
    ["no collections", JSON.stringify({ ...manifest, collections: {} }), "at least one collection"],
    ["a bad collection name", JSON.stringify({ ...manifest, collections: { "a/b": manifest.collections.decks } }), "name must be"],
    ["a collection without schema", JSON.stringify({ ...manifest, collections: { decks: { description: "x" } } }), "needs a description"],
  ])("rejects %s", (_label, raw, message) => {
    const result = parseManifest(raw);
    expect("error" in result && result.error).toContain(message);
  });
});

describe("validateDocument", () => {
  it("passes a matching document", () => {
    expect(validateDocument(deckSchema, { title: "Q3", slides: [{ heading: "Intro" }] })).toEqual([]);
  });

  it("reports where a document goes wrong", () => {
    const errors = validateDocument(deckSchema, { title: "", slides: [{}], extra: 1 });
    expect(errors.join("\n")).toMatch(/#\/title/);
    expect(errors.join("\n")).toMatch(/#\/slides\/0/);
    expect(errors.join("\n")).toMatch(/extra/);
  });

  it("caps the number of errors reported", () => {
    const schema = { type: "object", properties: { items: { type: "array", items: { type: "string" } } } };
    const errors = validateDocument(schema, { items: Array.from({ length: 50 }, (_, i) => i) });
    expect(errors.length).toBe(21);
    expect(errors.at(-1)).toMatch(/more$/);
  });
});

describe("declaredCollection", () => {
  it("finds declared collections only", () => {
    const m = parsed(manifest);
    expect("collection" in declaredCollection("slides", m, "decks")).toBe(true);
    const missing = declaredCollection("slides", m, "notes");
    expect("error" in missing && missing.error).toContain("Declared: decks");
    expect("error" in declaredCollection("slides", m, "toString")).toBe(true);
  });
});

describe("stripMeta / isDocId", () => {
  it("drops the backend's response fields", () => {
    expect(stripMeta({ id: "x", _owner: "u", _createdAt: 1, _updatedAt: 2, title: "t" })).toEqual({ title: "t" });
  });

  it("accepts backend ids and rejects path tricks", () => {
    expect(isDocId("mi3k2x9a1b2c3d4e5f60718")).toBe(true);
    expect(isDocId("../x")).toBe(false);
    expect(isDocId("a?b")).toBe(false);
    expect(isDocId("")).toBe(false);
  });
});

describe("fetchManifest", () => {
  const respond = (body: string, init?: ResponseInit) => (async () => new Response(body, init)) as unknown as typeof fetch;

  it("fetches the app's mcp.json from its host", async () => {
    let seen = "";
    const fetchFn = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify(manifest));
    }) as unknown as typeof fetch;
    const result = await fetchManifest("slides", fetchFn);
    expect(seen).toBe("https://slides.freeappstore.online/mcp.json");
    expect("manifest" in result).toBe(true);
  });

  it("says when an app has no mcp.json", async () => {
    const result = await fetchManifest("timer", respond("not found", { status: 404 }));
    expect("error" in result && result.error).toContain("doesn't support MCP data access");
  });

  it("refuses an oversized manifest", async () => {
    const result = await fetchManifest("big", respond("x".repeat(MANIFEST_MAX_BYTES + 1)));
    expect("error" in result && result.error).toContain("larger than");
  });

  it("reports an invalid manifest", async () => {
    const result = await fetchManifest("bad", respond(JSON.stringify({ version: 1 })));
    expect("error" in result && result.error).toContain("bad's mcp.json instructions");
  });

  it("reports a network failure", async () => {
    const fetchFn = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const result = await fetchManifest("slides", fetchFn);
    expect("error" in result && result.error).toContain("boom");
  });
});

describe("formatGuide", () => {
  it("includes the instructions and each collection's schema", () => {
    const text = formatGuide("slides", parsed(manifest));
    expect(text).toContain("A slide deck editor.");
    expect(text).toContain("### `decks`");
    expect(text).toContain('"required"');
  });
});

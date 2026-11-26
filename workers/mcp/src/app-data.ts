/**
 * App data over MCP (#734): an app opts in by shipping `mcp.json` at its root
 * (`web/public/mcp.json` → `https://<id>.freeappstore.online/mcp.json`). The
 * manifest tells the AI what the app is and which of the user's collections it
 * may read and write, each with a JSON Schema that documents are validated
 * against before they are written. Collections it does not declare are not
 * reachable over MCP.
 */
import { type Schema, Validator } from "@cfworker/json-schema";

export const MANIFEST_MAX_BYTES = 64 * 1024;
/** Same rule as the backend's collection names (packages/backend/src/routes/db.ts). */
const COLLECTION_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** Backend document ids are base36 time + hex; anything else cannot exist. */
const DOC_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
/** Fields the backend adds to every document it returns; never part of what is stored. */
const DOC_META_FIELDS = ["id", "_owner", "_createdAt", "_updatedAt"];
const MAX_REPORTED_ERRORS = 20;

export interface AppCollection {
  description: string;
  schema: Schema;
}

export interface AppManifest {
  version: 1;
  instructions: string;
  collections: Record<string, AppCollection>;
}

export const isDocId = (id: string) => DOC_ID_RE.test(id);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse and check an `mcp.json` body. Returns the manifest or what is wrong with it. */
export function parseManifest(raw: string): { manifest: AppManifest } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "mcp.json is not valid JSON" };
  }
  if (!isObject(data)) return { error: "mcp.json must be a JSON object" };
  if (data.version !== 1) return { error: "mcp.json version must be 1" };
  if (typeof data.instructions !== "string") return { error: "mcp.json instructions must be a string" };
  if (!isObject(data.collections) || Object.keys(data.collections).length === 0)
    return { error: "mcp.json collections must be an object with at least one collection" };
  const collections: Record<string, AppCollection> = {};
  for (const [name, entry] of Object.entries(data.collections)) {
    if (!COLLECTION_RE.test(name)) return { error: `mcp.json collection "${name}": name must be 1-64 letters, digits, - or _` };
    if (!isObject(entry) || typeof entry.description !== "string" || !isObject(entry.schema))
      return { error: `mcp.json collection "${name}" needs a description string and a schema object` };
    try {
      new Validator(entry.schema as Schema, "2020-12");
    } catch (e) {
      return { error: `mcp.json collection "${name}" has an unusable schema: ${e instanceof Error ? e.message : String(e)}` };
    }
    collections[name] = { description: entry.description, schema: entry.schema as Schema };
  }
  return { manifest: { version: 1, instructions: data.instructions, collections } };
}

/** Read a response body as text, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Fetch and parse `https://<appId>.freeappstore.online/mcp.json`. `appId` must already be a valid app id. */
export async function fetchManifest(appId: string, fetchFn: typeof fetch = fetch): Promise<{ manifest: AppManifest } | { error: string }> {
  const url = `https://${appId}.freeappstore.online/mcp.json`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    return { error: `Could not reach ${url} (${e instanceof Error ? e.message : String(e)}). Retry shortly.` };
  }
  if (res.status === 404)
    return {
      error: `${appId} doesn't support MCP data access: it has no mcp.json (${url}). Only apps that ship one expose their data.`,
    };
  if (!res.ok) return { error: `Could not read ${url}: HTTP ${res.status}. Retry shortly.` };
  const raw = await readCapped(res, MANIFEST_MAX_BYTES);
  if (raw === null) return { error: `${url} is larger than ${MANIFEST_MAX_BYTES} bytes.` };
  const parsed = parseManifest(raw);
  if ("error" in parsed) return { error: `${appId}'s ${parsed.error}.` };
  return parsed;
}

/** The collection's entry, or an error naming the collections the app does declare. */
export function declaredCollection(
  appId: string,
  manifest: AppManifest,
  collection: string,
): { collection: AppCollection } | { error: string } {
  const entry = Object.hasOwn(manifest.collections, collection) ? manifest.collections[collection] : undefined;
  if (entry) return { collection: entry };
  return {
    error: `${appId} has no MCP collection "${collection}". Declared: ${Object.keys(manifest.collections).join(", ")}. Use app_guide to read them.`,
  };
}

/** A document as stored: the backend's response metadata removed. */
export function stripMeta(doc: Record<string, unknown>): Record<string, unknown> {
  const out = { ...doc };
  for (const field of DOC_META_FIELDS) delete out[field];
  return out;
}

/** Validate a document against its collection's schema. Returns readable errors, empty when valid. */
export function validateDocument(schema: Schema, doc: unknown): string[] {
  const result = new Validator(schema, "2020-12", false).validate(doc);
  if (result.valid) return [];
  const lines = [...new Set(result.errors.map((e) => `${e.instanceLocation || "#"}: ${e.error}`))];
  return lines.length > MAX_REPORTED_ERRORS
    ? [...lines.slice(0, MAX_REPORTED_ERRORS), `…and ${lines.length - MAX_REPORTED_ERRORS} more`]
    : lines;
}

/** The text app_guide returns: the app's instructions, then each collection's description and schema. */
export function formatGuide(appId: string, manifest: AppManifest): string {
  const sections = Object.entries(manifest.collections).map(
    ([name, c]) => `### \`${name}\`\n\n${c.description}\n\n\`\`\`json\n${JSON.stringify(c.schema, null, 2)}\n\`\`\``,
  );
  return [
    `# ${appId} — app data guide`,
    manifest.instructions,
    "## Collections",
    "Documents belong to the signed-in user. Read them with app_data_list / app_data_get, write with app_data_save (validated against the schema), remove with app_data_delete. Changes appear in the app when the user is signed in.",
    ...sections,
  ].join("\n\n");
}

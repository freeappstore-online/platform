import { afterEach, expect, it, vi } from "vitest";
import { emptyNoOutputError, readOnlyStallAction, runAgentStep } from "./agent";
import { getConfig } from "./config";
import type { ToolResult } from "./providers/types";
import { executeTool } from "./tools";

const config = getConfig("apps");
afterEach(() => vi.unstubAllGlobals());
const existingApp = (version = "0.16.26") =>
  new Map(
    Object.entries({
      "package.json": JSON.stringify({ dependencies: { "@freeappstore/sdk": version } }),
      "web/package.json": "{}",
      "web/src/main.tsx": "// app-owned entry point",
      "web/src/App.tsx": "// existing app with saved data",
    }),
  );

// Exercise provider -> advertised chat tool -> actual turn file map, rather
// than calling the API/planner helper directly.
async function chat(files: Map<string, string>, input: Record<string, unknown>) {
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "cap", name: "install_capabilities", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      expect(request.tools.some((tool: { name: string }) => tool.name === "install_capabilities")).toBe(true);
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n`).join(""));
    }),
  );
  const step = await runAgentStep(
    { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "synthetic" },
    { systemPrompt: "Install the requested capability", messages: [{ role: "user", content: "Add persistence" }] },
    files,
    config,
    async () => {},
  );
  expect(step.kind).toBe("continue");
  if (step.kind !== "continue") throw new Error(step.kind);
  expect(emptyNoOutputError(step.appended, [], true)).toBeUndefined();
  expect(readOnlyStallAction(step.appended, true, undefined, false)).toBeUndefined();
  return step.appended.flatMap((message) => message.toolResults ?? [])[0] as ToolResult;
}

it("previews, applies and repeats a compatible install through chat while preserving infrastructure", async () => {
  const files = existingApp();
  const before = new Map(files);
  const preview = await chat(files, { capabilities: ["persistence"], dryRun: true });
  expect(JSON.parse(preview.content).status).toBe("preview");
  expect(files).toEqual(before);
  const applied = await chat(files, { capabilities: ["persistence"], dryRun: false });
  expect(applied.isError).toBe(false);
  expect(JSON.parse(applied.content).status).toBe("applied");
  expect(files.has("fas-capabilities/persistence.ts")).toBe(true);
  expect(files.has(".fas-capabilities.json")).toBe(true);
  for (const [path, content] of before) expect(files.get(path)).toBe(content);
  const installed = new Map(files);
  await chat(files, { capabilities: ["persistence"], dryRun: false });
  expect(files).toEqual(installed);
  expect(
    (await executeTool({ id: "lock", name: "write_file", input: { path: "package.json", content: "{}" } }, files, config)).isError,
  ).toBe(true);
});

it.each([true, false])("reports insufficient packages without writes (dryRun=%s)", async (dryRun) => {
  const files = existingApp("0.14.30");
  const before = new Map(files);
  const result = await chat(files, { capabilities: ["persistence"], dryRun });
  expect(result.isError).toBe(true);
  expect(result.content).toContain("pnpm install");
  expect(result.content).toContain("fas add");
  expect(result.content).toContain("0.16.18");
  expect(files).toEqual(before);
});

it("preserves edited generated files even with explicit update and makes multi-capability failure atomic", async () => {
  const files = existingApp();
  await chat(files, { capabilities: ["persistence"], dryRun: false });
  files.set("fas-capabilities/persistence.ts", "// developer edits");
  const before = new Map(files);
  const result = await chat(files, { capabilities: ["connectivity", "persistence"], dryRun: false, update: true });
  expect(result.isError).toBe(true);
  expect(files).toEqual(before);
});

it.each([
  { capabilities: ["unknown"], dryRun: false },
  { capabilities: ["persistence"] },
  { capabilities: [], dryRun: false },
  { capabilities: ["persistence"], dryRun: false, update: "true" },
])("rejects invalid chat requests without writes: %j", async (input) => {
  const files = existingApp();
  const before = new Map(files);
  expect((await chat(files, input)).isError).toBe(true);
  expect(files).toEqual(before);
});

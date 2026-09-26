/**
 * Unit tests for runAgentTurn — covers the non-thrown error paths that
 * #40 (P0-B) makes visible via result.terminalError.
 */

import { describe, expect, it } from "vitest";
import { collectUsage, runAgentTurn, STALL_NUDGE, STALL_VISIBLE_ERROR } from "./agent";
import { getConfig } from "./config";
import type { AIConfig, StreamEvent } from "./providers/types";

const storeConfig = getConfig("apps");

const aiConfig: AIConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "sk-test",
};

/** Build a WritableStream + collect the SSE lines written to it. */
function makeWriter(): { writer: WritableStreamDefaultWriter<Uint8Array>; events: () => StreamEvent[] } {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
  const writer = writable.getWriter();
  const events = () => {
    const decoder = new TextDecoder();
    const raw = chunks.map((c) => decoder.decode(c)).join("");
    return raw
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as StreamEvent);
  };
  return { writer, events };
}

/** Patch globalThis.fetch to return a mock Anthropic response. */
function mockFetch(responseBody: string, status = 200) {
  (globalThis as any).fetch = async () =>
    new Response(responseBody, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
}

/** Make a minimal SSE body that yields a single Anthropic error event (non-2xx path). */
function makeAnthropicErrorBody(status: number, errorText: string) {
  // Non-2xx: body is plain text error, not SSE
  return errorText;
}

/** Make an SSE body that simulates a clean text-only reply with no tool calls. */
function makeTextOnlySSE(text: string): string {
  const lines: string[] = [
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `data: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 5 } })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
  ];
  return lines.join("\n") + "\n";
}

/** Make an SSE body that simulates a read_file tool call then stop. */
function makeReadFileSSE(): string {
  const toolUseBlock = { type: "tool_use", id: "tu_1", name: "read_file", input: {} };
  const lines: string[] = [
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 20 } } })}`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: toolUseBlock })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"web/src/App.tsx"}' } })}`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `data: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 10 } })}`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
  ];
  return lines.join("\n") + "\n";
}

describe("runAgentTurn — terminalError surface (issue #40)", () => {
  it("(a) returns terminalError when Anthropic yields a non-2xx API error event", async () => {
    // Simulate a 529 / overloaded response
    (globalThis as any).fetch = async () =>
      new Response(makeAnthropicErrorBody(529, "Overloaded"), {
        status: 529,
        headers: { "content-type": "text/plain" },
      });

    const { writer, events } = makeWriter();
    const files = new Map<string, string>([["web/src/App.tsx", "export default function App() { return <div/>; }"]]);

    const result = await runAgentTurn(aiConfig, [], "Build me an app", files, writer, storeConfig);

    expect(result.terminalError).toBeDefined();
    expect(result.terminalError).toContain("529");

    // The error SSE event must also have been sent to the stream
    const sent = events();
    expect(sent.some((e) => e.type === "error")).toBe(true);
  });

  it("(b) returns terminalError=empty-no-output when model issues only read_file then stops", async () => {
    // Two-call mock: first call returns read_file tool call, second returns text-only
    let callCount = 0;
    (globalThis as any).fetch = async () => {
      callCount++;
      const body = callCount === 1 ? makeReadFileSSE() : makeTextOnlySSE("I read the file, looks good.");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const { writer } = makeWriter();
    const files = new Map<string, string>([["web/src/App.tsx", "export default function App() { return <div/>; }"]]);

    const result = await runAgentTurn(aiConfig, [], "Update the app", files, writer, storeConfig);

    expect(result.terminalError).toBeDefined();
    expect(result.terminalError).toContain("empty-no-output");
    expect(result.infraRequests).toHaveLength(0);
  });

  it("successful builds with write_file do NOT set terminalError", async () => {
    // Simulate a write_file tool call (which is a file tool, not infra) followed by text
    const writeFileBlock = { type: "tool_use", id: "tu_2", name: "write_file", input: {} };
    const writeFileSSE =
      [
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 20 } } })}`,
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: writeFileBlock })}`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"web/src/App.tsx","content":"<div/>"}' } })}`,
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
        `data: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 10 } })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
      ].join("\n") + "\n";

    let callCount = 0;
    (globalThis as any).fetch = async () => {
      callCount++;
      const body = callCount === 1 ? writeFileSSE : makeTextOnlySSE("Done.");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const { writer } = makeWriter();
    const files = new Map<string, string>([["web/src/App.tsx", ""]]);

    const result = await runAgentTurn(aiConfig, [], "Update the app", files, writer, storeConfig);

    expect(result.terminalError).toBeUndefined();
  });

  it("pure conversational reply (no tool calls at all) does NOT set terminalError", async () => {
    (globalThis as any).fetch = async () =>
      new Response(makeTextOnlySSE("Hello! What would you like to build?"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const { writer } = makeWriter();
    const files = new Map<string, string>();

    const result = await runAgentTurn(aiConfig, [], "Hi", files, writer, storeConfig);

    expect(result.terminalError).toBeUndefined();
    expect(result.infraRequests).toHaveLength(0);
  });
});

describe("runAgentTurn — tool_result SSE redaction (issue #36)", () => {
  // Invariant: tool_result events carry only { id, tool }. Tool output (file
  // bodies, search hits, error text) must never be streamed to the builder
  // chat. session.ts emits the same shape for infra tools.
  it("tool_result events carry no result payload and no file content", async () => {
    let callCount = 0;
    (globalThis as any).fetch = async () => {
      callCount++;
      const body = callCount === 1 ? makeReadFileSSE() : makeTextOnlySSE("Looks good.");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const secret = "export default function App() { return <div className='leak-marker'/>; }";
    const { writer, events } = makeWriter();
    const files = new Map<string, string>([["web/src/App.tsx", secret]]);

    await runAgentTurn(aiConfig, [], "Update the app", files, writer, storeConfig);

    const toolResults = events().filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    const payload = JSON.parse(toolResults[0].data as string);
    expect(payload).toEqual({ id: "tu_1", tool: "read_file" });
    expect(payload).not.toHaveProperty("result");
    expect(toolResults[0].data).not.toContain("leak-marker");
  });
});

/** An Anthropic SSE body with one tool call. */
function makeToolSSE(name: string, input: Record<string, unknown>): string {
  const block = { type: "tool_use", id: `tu_${name}`, name, input: {} };
  return (
    [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 20 } } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: block })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 10 } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n") + "\n"
  );
}

/** An Anthropic SSE body that ends without any content block. */
function makeEmptySSE(): string {
  return (
    [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 20 } } })}`,
      `data: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 0 } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n") + "\n"
  );
}

/** Serve `bodies` in order and record each request's messages. */
function scriptFetch(bodies: string[]) {
  const requests: Array<Array<{ role: string; content: unknown }>> = [];
  (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).messages);
    const body = bodies[requests.length - 1] ?? makeTextOnlySSE("(unexpected extra call)");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return requests;
}

const readFile = () => makeToolSSE("read_file", { path: "web/src/index.css" });
const writeFile = () => makeToolSSE("write_file", { path: "web/src/App.tsx", content: "<main/>" });
const newApp = { appId: null, appName: null, fileCount: 1, fileList: "web/src/index.css" };

describe("runAgentTurn — read-only stall nudge (issue #37)", () => {
  it("nudges once after a read-only stall, and the build continues to write files", async () => {
    const requests = scriptFetch([readFile(), makeTextOnlySSE("Let me start building it!"), writeFile(), makeTextOnlySSE("Done.")]);
    const { writer, events } = makeWriter();
    const files = new Map([["web/src/index.css", ":root{}"]]);

    const result = await runAgentTurn(aiConfig, [], "chinese dictionary app", files, writer, storeConfig, newApp);

    expect(requests).toHaveLength(4);
    // The third model call carries the nudge as its latest user message.
    expect(requests[2].at(-1)).toEqual({ role: "user", content: STALL_NUDGE });
    expect(files.get("web/src/App.tsx")).toBe("<main/>");
    expect(result.terminalError).toBeUndefined();
    // Persisted, but flagged so the console never shows it as the creator's words.
    expect(result.newMessages).toContainEqual({ role: "user", content: STALL_NUDGE, internal: true });
    expect(events().some((e) => e.type === "error")).toBe(false);
  });

  it("gives up visibly when the model stalls again after the nudge", async () => {
    const requests = scriptFetch([readFile(), makeTextOnlySSE("Let me start building it!"), makeTextOnlySSE("On it!")]);
    const { writer, events } = makeWriter();

    const result = await runAgentTurn(aiConfig, [], "chinese dictionary app", new Map(), writer, storeConfig, newApp);

    expect(requests).toHaveLength(3); // exactly one nudge, no loop
    expect(result.terminalError).toContain("empty-no-output");
    expect(events()).toContainEqual({ type: "error", data: STALL_VISIBLE_ERROR });
    expect(result.newMessages.at(-1)).toEqual({ role: "assistant", content: STALL_VISIBLE_ERROR });
  });

  it("does not nudge a deployed app, where read-then-answer is a normal question", async () => {
    const requests = scriptFetch([readFile(), makeTextOnlySSE("Your app stores entries in KV.")]);
    const { writer, events } = makeWriter();
    const deployed = { ...newApp, appId: "dict", appName: "Dict" };

    await runAgentTurn(aiConfig, [], "how does my app store data?", new Map(), writer, storeConfig, deployed);

    expect(requests).toHaveLength(2);
    expect(events().some((e) => e.type === "error")).toBe(false);
  });

  it("drops an empty stalled answer so the nudge request stays valid", async () => {
    const requests = scriptFetch([readFile(), makeEmptySSE(), writeFile(), makeTextOnlySSE("Done.")]);
    const { writer } = makeWriter();

    const result = await runAgentTurn(aiConfig, [], "chinese dictionary app", new Map(), writer, storeConfig, newApp);

    const nudgeRequest = requests[2];
    expect(nudgeRequest.at(-1)).toEqual({ role: "user", content: STALL_NUDGE });
    expect(nudgeRequest.at(-2)?.role).not.toBe("assistant"); // no empty assistant turn before the nudge
    expect(result.terminalError).toBeUndefined();
  });
});

describe("token usage (#16)", () => {
  const usageEvent = (input: number, output: number) => ({ type: "usage" as const, data: JSON.stringify({ input, output }) });

  it("collectUsage takes the largest value per field, which is right for every provider", async () => {
    const seen: string[] = [];
    // Anthropic: input and output arrive in separate events.
    const anthropic = collectUsage(async (e) => void seen.push(e.type));
    await anthropic.emit(usageEvent(120, 0));
    await anthropic.emit(usageEvent(0, 45));
    expect(anthropic.usage).toEqual({ input: 120, output: 45 });
    expect(seen).toEqual(["usage", "usage"]); // events still reach the stream

    // Google: cumulative totals repeated on every chunk. Summing would triple-count.
    const google = collectUsage(async () => {});
    await google.emit(usageEvent(300, 10));
    await google.emit(usageEvent(300, 25));
    await google.emit(usageEvent(300, 40));
    expect(google.usage).toEqual({ input: 300, output: 40 });
  });

  it("a provider that reports no usage, or garbage, counts zero without throwing", async () => {
    const none = collectUsage(async () => {});
    await none.emit({ type: "text", data: "hi" });
    expect(none.usage).toEqual({ input: 0, output: 0 });

    const bad = collectUsage(async () => {});
    await bad.emit({ type: "usage", data: "not json" });
    await bad.emit({ type: "usage", data: JSON.stringify({ input: "lots" }) });
    expect(bad.usage).toEqual({ input: 0, output: 0 });
  });

  it("runAgentTurn adds up each model call's usage", async () => {
    // write_file call (20 in / 10 out), then a text answer (10 in / 5 out).
    scriptFetch([writeFile(), makeTextOnlySSE("Done.")]);
    const { writer } = makeWriter();

    const result = await runAgentTurn(aiConfig, [], "build it", new Map(), writer, storeConfig);

    expect(result.usage).toEqual({ input: 30, output: 15 });
  });
});

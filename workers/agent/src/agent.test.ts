/**
 * Unit tests for runAgentTurn — covers the non-thrown error paths that
 * #40 (P0-B) makes visible via result.terminalError.
 */

import { describe, expect, it } from "vitest";
import { runAgentTurn } from "./agent";
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
    const writeFileSSE = [
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

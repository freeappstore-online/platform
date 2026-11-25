/**
 * Unit tests for the agent step (runAgentStep) and the turn helpers the
 * alarm-driven session loop calls between steps.
 */

import { describe, expect, it } from "vitest";
import { appendStallNudge, collectUsage, emptyNoOutputError, prepareTurn, readOnlyStallAction, runAgentStep, STALL_NUDGE } from "./agent";
import { getConfig } from "./config";
import type { AIConfig, StreamEvent } from "./providers/types";

const storeConfig = getConfig("apps");

describe("prepareTurn tool history recovery", () => {
  it("drops an empty assistant message stored by an earlier build (#599)", () => {
    const prepared = prepareTurn(
      aiConfig,
      [
        { role: "user", content: "Build it" },
        { role: "assistant", content: "" },
      ],
      "Continue",
      storeConfig,
    );
    expect(prepared.messages).toEqual([
      { role: "user", content: "Build it" },
      { role: "user", content: "Continue" },
    ]);
  });

  it("fills a missing result for each tool call id before continuing", () => {
    const prepared = prepareTurn(
      aiConfig,
      [
        { role: "user", content: "Build it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "toolu_012n2ra7bvJ4Xfk54r4Q8duX", name: "install_capabilities", input: {} },
            { id: "tu_present", name: "fetch_url", input: {} },
          ],
        },
        { role: "tool_result", content: "", toolResults: [{ id: "tu_present", content: "Fetched" }] },
        { role: "user", content: "The action completed. Summarize the result briefly for the user." },
      ],
      "Continue building",
      storeConfig,
    );

    const toolResult = prepared.messages.find((message) => message.role === "tool_result");
    expect(toolResult?.toolResults?.map((result) => result.id)).toEqual(["toolu_012n2ra7bvJ4Xfk54r4Q8duX", "tu_present"]);
    expect(toolResult?.toolResults?.[0]).toMatchObject({ isError: true });
    expect(prepared.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool_result", "user", "user"]);
  });

  it("keeps the infra result when file and infra results were stored as two rows (#598)", () => {
    const prepared = prepareTurn(
      aiConfig,
      [
        { role: "user", content: "Build it" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "tu_write", name: "write_file", input: {} },
            { id: "tu_deploy", name: "deploy", input: {} },
          ],
        },
        { role: "tool_result", content: "", toolResults: [{ id: "tu_write", content: "Wrote web/src/App.tsx" }] },
        { role: "tool_result", content: "", toolResults: [{ id: "tu_deploy", content: "Deploy FAILED: TS2322" }] },
      ],
      "Fix it",
      storeConfig,
    );

    const rows = prepared.messages.filter((message) => message.role === "tool_result");
    expect(rows).toHaveLength(1);
    expect(rows[0].toolResults).toEqual([
      { id: "tu_write", content: "Wrote web/src/App.tsx" },
      { id: "tu_deploy", content: "Deploy FAILED: TS2322" },
    ]);
  });

  it("preserves tool calls when the persisted result group is entirely missing", () => {
    const prepared = prepareTurn(
      aiConfig,
      [
        { role: "user", content: "Build it" },
        { role: "assistant", content: "", toolCalls: [{ id: "lost-result", name: "write_file", input: {} }] },
        { role: "user", content: "Continue" },
      ],
      "Resume",
      storeConfig,
    );

    expect(prepared.messages[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "lost-result" }] });
    expect(prepared.messages[2]).toMatchObject({
      role: "tool_result",
      toolResults: [{ id: "lost-result", isError: true }],
    });
    expect(prepared.messages[3]).toMatchObject({ role: "user", content: "Continue" });
  });
});

const aiConfig: AIConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "sk-test",
};

/** An Emit that records every event it is given. */
function makeEmit(): { emit: (e: StreamEvent) => Promise<void>; events: StreamEvent[] } {
  const events: StreamEvent[] = [];
  return { emit: async (e) => void events.push(e), events };
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
});

const step = (prepared = prepareTurn(aiConfig, [], "Update the app", storeConfig), files = new Map<string, string>()) => {
  const { emit, events } = makeEmit();
  return { run: () => runAgentStep(aiConfig, prepared, files, storeConfig, emit), events };
};

describe("runAgentStep — provider errors (#40)", () => {
  it("returns stream_error, and emits it, when Anthropic answers non-2xx", async () => {
    mockFetch(makeAnthropicErrorBody(529, "Overloaded"), 529);
    const { run, events } = step();
    const outcome = await run();
    expect(outcome.kind).toBe("stream_error");
    if (outcome.kind === "stream_error") expect(outcome.message).toContain("529");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("flags a turn that only read files as empty-no-output, but not a write or a plain reply", () => {
    const read = [{ role: "assistant" as const, content: "", toolCalls: [{ id: "r", name: "read_file", input: {} }] }];
    const write = [{ role: "assistant" as const, content: "", toolCalls: [{ id: "w", name: "write_file", input: {} }] }];
    expect(emptyNoOutputError(read, [], true)).toContain("empty-no-output");
    expect(emptyNoOutputError(write, [], true)).toBeUndefined();
    expect(emptyNoOutputError([{ role: "assistant", content: "Hello!" }], [], false)).toBeUndefined();
  });
});

describe("runAgentStep — tool_result SSE redaction (#36)", () => {
  // Invariant: tool_result events carry only { id, tool }. Tool output (file
  // bodies, search hits, error text) must never be streamed to the builder
  // chat. session.ts emits the same shape for infra tools.
  it("tool_result events carry no result payload and no file content", async () => {
    mockFetch(makeReadFileSSE());
    const secret = "export default function App() { return <div className='leak-marker'/>; }";
    const { run, events } = step(undefined, new Map([["web/src/App.tsx", secret]]));

    const outcome = await run();

    expect(outcome.kind).toBe("continue");
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    const payload = JSON.parse(toolResults[0].data as string);
    expect(payload).toEqual({ id: "tu_1", tool: "read_file" });
    expect(toolResults[0].data).not.toContain("leak-marker");
  });
});

describe("read-only stall helpers (#37)", () => {
  const readOnly = [
    { role: "assistant" as const, content: "", toolCalls: [{ id: "r", name: "read_file", input: {} }] },
    { role: "assistant" as const, content: "On it!" },
  ];

  it("nudges a new app once, then gives up; leaves a deployed app alone", () => {
    expect(readOnlyStallAction(readOnly, true, null, false)).toBe("nudge");
    expect(readOnlyStallAction(readOnly, true, null, true)).toBe("give_up");
    expect(readOnlyStallAction(readOnly, true, "dict", false)).toBeUndefined();
  });

  it("drops an empty stalled answer so the nudge request stays valid", () => {
    const model = [
      { role: "user" as const, content: "build" },
      { role: "assistant" as const, content: "" },
    ];
    const turn = [
      { role: "user" as const, content: "build" },
      { role: "assistant" as const, content: "" },
    ];
    appendStallNudge(model, turn);
    for (const list of [model, turn]) {
      expect(list.at(-1)).toEqual({ role: "user", content: STALL_NUDGE, internal: true });
      expect(list.at(-2)?.role).toBe("user");
    }
  });
});

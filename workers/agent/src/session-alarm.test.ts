// Alarm-driven build loop (#41). AgentSession runs against a mock
// DurableObjectState whose storage structured-clones values (like real DO
// storage), so nothing survives between steps unless it was persisted. The
// model and infra tools are scripted; everything else is the real session code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepOutcome } from "./agent";
import { runAgentStep, runAgentTurn } from "./agent";
import { executeInfraTool } from "./infra-exec";
import type { Message } from "./providers/types";
import { AgentSession, INFRA_STALL_THRESHOLD_MS, type PendingTurn, STALL_THRESHOLD_MS } from "./session";

vi.mock("./agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent")>();
  return { ...actual, runAgentStep: vi.fn(), runAgentTurn: vi.fn() };
});
vi.mock("./infra-exec", () => ({ executeInfraTool: vi.fn() }));

const stepMock = vi.mocked(runAgentStep);
const turnMock = vi.mocked(runAgentTurn);
const infraMock = vi.mocked(executeInfraTool);

const API_KEY = "sk-test-secret-123456";

// ── Fakes ──

function fakeState() {
  const store = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const storage = {
    get: async (k: string) => structuredClone(store.get(k)),
    // The write lands a tick later, like real storage I/O, so an un-awaited
    // put is observably not there yet.
    put: async (k: string, v: unknown) => {
      const copy = structuredClone(v);
      await new Promise((r) => setTimeout(r, 0));
      store.set(k, copy);
    },
    delete: async (k: string | string[]) => {
      for (const key of [k].flat()) store.delete(key);
      return true;
    },
    setAlarm: async (t: number) => {
      alarmAt = t;
    },
    getAlarm: async () => alarmAt,
    deleteAlarm: async () => {
      alarmAt = null;
    },
  };
  return { state: { storage, waitUntil: () => {} } as unknown as DurableObjectState, store, alarmAt: () => alarmAt };
}

function fakeEnv(alarmLoop = "true") {
  const d1Writes: Array<{ messages: Message[]; errors: Array<{ source: string; message: string }> }> = [];
  const DB = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          d1Writes.push({ messages: JSON.parse(args[0] as string), errors: JSON.parse(args[2] as string) });
          return {};
        },
      }),
    }),
  };
  const PLATFORM = { fetch: async () => new Response(JSON.stringify({ id: "u1", login: "alice" })) };
  return { env: { STORE: "apps", ALARM_LOOP: alarmLoop, GITHUB_TOKEN: "gh", DB, PLATFORM } as any, d1Writes };
}

function chatRequest(message = "build me a timer") {
  return new Request("https://agent/chat", {
    method: "POST",
    headers: { Authorization: "Bearer tok", "X-Session-Id": "sess-1", "Content-Type": "application/json" },
    body: JSON.stringify({ message, aiConfig: { provider: "anthropic", model: "m", apiKey: API_KEY } }),
  });
}

/** Script runAgentStep: each entry may touch files / emit, then returns its outcome. */
function scriptSteps(
  ...steps: Array<StepOutcome | ((files: Map<string, string>, emit: (e: any) => Promise<void>) => Promise<StepOutcome>)>
) {
  stepMock.mockImplementation(async (_cfg, _prepared, files, _store, emit) => {
    const next = steps.shift();
    if (!next) throw new Error("runAgentStep called more times than scripted");
    return typeof next === "function" ? next(files, emit) : next;
  });
}

const assistant = (content: string, toolCalls?: Message["toolCalls"]): Message => ({ role: "assistant", content, toolCalls });

async function pendingOf(store: Map<string, unknown>) {
  return store.get("pendingTurn") as PendingTurn | undefined;
}

function latestTurnLog(store: Map<string, unknown>) {
  const turnId = store.get("latestTurnId") as string | undefined;
  return turnId ? (store.get(`turnEvents:${turnId}`) as any) : undefined;
}

function parseSSE(body: string) {
  return body
    .trim()
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => {
      let id: string | undefined;
      let data = "";
      for (const rawLine of block.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith("id:")) id = line.slice(3).trim();
        if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      return { id, data: JSON.parse(data) };
    });
}

/** Run alarms until the turn ends (or a safety cap). Returns alarms fired. */
async function drain(session: AgentSession, store: Map<string, unknown>, cap = 50) {
  let n = 0;
  while (store.has("pendingTurn") && n < cap) {
    await session.alarm();
    n++;
  }
  return n;
}

beforeEach(() => {
  stepMock.mockReset();
  turnMock.mockReset();
  infraMock.mockReset();
});
afterEach(() => vi.useRealTimers());

// ── Tests ──

describe("ALARM_LOOP=true: /chat", () => {
  it("persists the pending turn and arms an immediate alarm instead of running the model", async () => {
    const { state, store, alarmAt } = fakeState();
    const session = new AgentSession(state, fakeEnv().env);
    const before = Date.now();
    const res = await session.fetch(chatRequest());
    await res.body?.cancel();

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(stepMock).not.toHaveBeenCalled();
    expect(turnMock).not.toHaveBeenCalled();
    const pending = await pendingOf(store);
    expect(pending).toMatchObject({ phase: "main", loopIndex: 0, message: "build me a timer" });
    expect(pending!.heartbeat).toBeGreaterThanOrEqual(before);
    expect(alarmAt()).toBeGreaterThanOrEqual(before);
    expect(alarmAt()).toBeLessThanOrEqual(Date.now());
  });

  it("rejects a second /chat while a turn is persisted, even after eviction", async () => {
    const { state, store } = fakeState();
    const { env } = fakeEnv();
    const first = await new AgentSession(state, env).fetch(chatRequest());
    await first.body?.cancel();
    // New instance = evicted DO: the in-memory flag is gone, storage is not.
    const second = await new AgentSession(state, env).fetch(chatRequest("again"));
    const body = (await second.json()) as any;
    expect(second.status).toBe(409);
    expect(second.headers.get("Retry-After")).toBe("2");
    expect(second.headers.get("Last-Event-ID")).toBe("0");
    expect(body).toMatchObject({
      error: "A build is already in progress.",
      turnId: (store.get("pendingTurn") as PendingTurn).turnId,
      liveUrl: "/live",
      status: { state: "working", detail: "Building…" },
    });
  });

  it("reports working status from pendingTurn after a cold start", async () => {
    const { state } = fakeState();
    const { env } = fakeEnv();
    const first = await new AgentSession(state, env).fetch(chatRequest());
    await first.body?.cancel();

    const status = await new AgentSession(state, env).fetch(new Request("https://agent/status"));
    expect(status.status).toBe(200);
    expect(((await status.json()) as any).devStatus).toEqual({ state: "working", detail: "Building…" });
  });

  it("returns the current event cursor so a conflicting chat can reconnect without replaying seen events", async () => {
    const { state, store } = fakeState();
    const { env } = fakeEnv();
    const session = new AgentSession(state, env);
    const first = await session.fetch(chatRequest());
    await first.body?.cancel();

    scriptSteps({ kind: "rate_limited" });
    await session.alarm();
    expect(latestTurnLog(store).events).toHaveLength(1);

    const second = await new AgentSession(state, env).fetch(chatRequest("again"));
    const body = (await second.json()) as any;
    expect(second.status).toBe(409);
    expect(second.headers.get("Last-Event-ID")).toBe("1");
    expect(body.turnId).toBe((store.get("pendingTurn") as PendingTurn).turnId);
  });
});

describe("ALARM_LOOP=true: alarm()", () => {
  it("runs one step per alarm and completes with the client gone (tab closed)", async () => {
    const { state, store, alarmAt } = fakeState();
    const { env, d1Writes } = fakeEnv();
    const session = new AgentSession(state, env);
    const res = await session.fetch(chatRequest());
    await res.body?.cancel(); // nobody is listening from here on

    scriptSteps(
      async (files) => {
        files.set("web/src/App.tsx", "export default 1");
        const call = { id: "t1", name: "write_file", input: { path: "web/src/App.tsx" } };
        return {
          kind: "continue",
          appended: [assistant("", [call]), { role: "tool_result", content: "", toolResults: [{ id: "t1", content: "ok" }] }],
        };
      },
      { kind: "final", appended: [assistant("Done — your timer is ready.")] },
    );

    await session.alarm();
    // After one step: progress is persisted and the next step is scheduled.
    const mid = await pendingOf(store);
    expect(mid).toMatchObject({ phase: "main", loopIndex: 1 });
    expect((store.get("session") as any).files["web/src/App.tsx"]).toBe("export default 1");
    expect(alarmAt()).toBeGreaterThan(Date.now());

    await session.alarm();
    expect(store.has("pendingTurn")).toBe(false);
    const msgs = (store.get("session") as any).messages as Message[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool_result", "assistant"]);
    expect(msgs.at(-1)!.content).toBe("Done — your timer is ready.");
    expect(d1Writes.at(-1)!.messages).toHaveLength(4);
    const events = latestTurnLog(store).events;
    expect(events.at(-1).type).toBe("done");
  });

  it("resumes from the persisted step on a fresh instance (DO evicted between alarms)", async () => {
    const { state, store } = fakeState();
    const { env } = fakeEnv();
    const res = await new AgentSession(state, env).fetch(chatRequest());
    await res.body?.cancel();

    scriptSteps({
      kind: "continue",
      appended: [assistant("", [{ id: "a", name: "read_file", input: {} }]), { role: "tool_result", content: "", toolResults: [] }],
    });
    await new AgentSession(state, env).alarm();

    scriptSteps({ kind: "final", appended: [assistant("resumed fine")] });
    const fresh = new AgentSession(state, env);
    await fresh.alarm();
    // The second step saw the first step's messages, from storage.
    const prepared = stepMock.mock.calls[0]![1];
    expect(prepared.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool_result"]);
    expect(store.has("pendingTurn")).toBe(false);
    expect((store.get("session") as any).messages.at(-1).content).toBe("resumed fine");
  });

  it("marks a stale turn stalled: error in session.errors and D1, turn cleared", async () => {
    const { state, store } = fakeState();
    const { env, d1Writes } = fakeEnv();
    const session = new AgentSession(state, env);
    const res = await session.fetch(chatRequest());
    await res.body?.cancel();

    const pending = (await pendingOf(store))!;
    pending.heartbeat = Date.now() - STALL_THRESHOLD_MS - 1000;
    store.set("pendingTurn", pending);

    await session.alarm();
    expect(stepMock).not.toHaveBeenCalled();
    expect(store.has("pendingTurn")).toBe(false);
    const errors = (store.get("session") as any).errors;
    expect(errors.at(-1)).toMatchObject({ source: "alarm" });
    expect(errors.at(-1).message).toMatch(/stalled/i);
    expect(d1Writes.at(-1)!.errors.at(-1)!.source).toBe("alarm");
    expect((store.get("session") as any).messages.at(-1).content).toMatch(/^Error: Build stalled/);
  });

  it("marks a hung upstream stalled within STALL_THRESHOLD_MS", async () => {
    const { state, store } = fakeState();
    const { env } = fakeEnv();
    const session = new AgentSession(state, env);
    const res = await session.fetch(chatRequest());
    await res.body?.cancel();

    vi.useFakeTimers();
    stepMock.mockImplementation(() => new Promise<StepOutcome>(() => {})); // never answers
    let finished = false;
    const running = session.alarm().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(STALL_THRESHOLD_MS - 1000);
    expect(finished).toBe(false); // not before the threshold
    await vi.advanceTimersByTimeAsync(1010);
    // The stall handler's own storage writes each take a (fake) tick.
    for (let i = 0; i < 50 && !finished; i++) await vi.advanceTimersByTimeAsync(1);
    await running;

    expect(store.has("pendingTurn")).toBe(false);
    expect((store.get("session") as any).errors.at(-1)).toMatchObject({ source: "alarm" });
  });

  it("clears a turn whose alarm was lost, so it cannot lock the session", async () => {
    const { state, store } = fakeState();
    const { env } = fakeEnv();
    const first = await new AgentSession(state, env).fetch(chatRequest());
    await first.body?.cancel();
    const pending = (await pendingOf(store))!;
    pending.heartbeat = Date.now() - INFRA_STALL_THRESHOLD_MS - 1000;
    store.set("pendingTurn", pending);

    const second = await new AgentSession(state, env).fetch(chatRequest("try again"));
    await second.body?.cancel();
    expect(second.status).toBe(200);
    expect((store.get("session") as any).errors.some((e: any) => e.source === "alarm")).toBe(true);
    expect((await pendingOf(store))!.message).toBe("try again");
  });

  it("backs off on rate limits without advancing the step", async () => {
    const { state, store, alarmAt } = fakeState();
    const session = new AgentSession(state, fakeEnv().env);
    const res = await session.fetch(chatRequest());
    await res.body?.cancel();

    scriptSteps({ kind: "rate_limited" });
    const t0 = Date.now();
    await session.alarm();
    expect(await pendingOf(store)).toMatchObject({ loopIndex: 0, retries: 1 });
    expect(alarmAt()!).toBeGreaterThanOrEqual(t0 + 5000);
  });

  it("runs infra tools one per alarm with awaited status writes, then the follow-up", async () => {
    const { state, store } = fakeState();
    const { env } = fakeEnv();
    const session = new AgentSession(state, env);
    const res = await session.fetch(chatRequest());
    await res.body?.cancel();

    const deploy = { id: "d1", name: "deploy", input: { id: "timer" } };
    scriptSteps(
      { kind: "infra", appended: [assistant("Deploying", [deploy])], infraRequests: [{ toolCall: deploy }] },
      { kind: "final", appended: [assistant("It's live at timer.freeappstore.online")] },
    );
    let sawPersistedStatus: string | undefined;
    infraMock.mockImplementation(async (_tc, ctx) => {
      await ctx.onAppDeployed("timer", "Timer");
      await ctx.onDeployStatus({ phase: "live", appUrl: "https://timer.freeappstore.online" });
      // The awaited put has landed in storage before the tool moves on.
      sawPersistedStatus = (store.get("session") as any).deployStatus?.phase;
      return "Deployed timer";
    });

    await session.alarm(); // main LLM step → infra requested
    expect(await pendingOf(store)).toMatchObject({ phase: "main-infra" });
    await session.alarm(); // the deploy tool
    expect(sawPersistedStatus).toBe("live");
    expect(await pendingOf(store)).toMatchObject({ phase: "followup" });
    await drain(session, store);

    const msgs = (store.get("session") as any).messages as Message[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool_result", "user", "assistant"]);
    expect(msgs[2]!.toolResults).toEqual([{ id: "d1", content: "Deployed timer" }]);
    expect(msgs[3]!.content).toMatch(/Summarize the result/);
    expect((store.get("session") as any).appId).toBe("timer");
    const types = latestTurnLog(store).events.map((e: any) => e.type);
    expect(types).toContain("deploy_status");
    expect(types.at(-1)).toBe("done");
  });

  it("assigns sequential SSE event ids", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv().env);
    const res = await session.fetch(chatRequest());

    scriptSteps(async (_files, emit) => {
      await emit({ type: "text", data: "first" });
      await emit({ type: "text", data: "second" });
      return { kind: "final", appended: [assistant("firstsecond")] };
    });
    await drain(session, store);

    const events = parseSSE(await res.text());
    expect(events.map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(events.map((e) => e.data.type)).toEqual(["text", "text", "done"]);
    expect(latestTurnLog(store).events.map((e: any) => e.seq)).toEqual([1, 2, 3]);
  });

  it("reconnects with Last-Event-ID and replays only missed events", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv().env);
    const res = await session.fetch(chatRequest());
    await res.body?.cancel();

    scriptSteps(async (_files, emit) => {
      await emit({ type: "text", data: "one" });
      await emit({ type: "text", data: "two" });
      return { kind: "final", appended: [assistant("onetwo")] };
    });
    await drain(session, store);

    const live = await session.fetch(
      new Request("https://agent/live", {
        headers: { Authorization: "Bearer tok", "Last-Event-ID": "1" },
      }),
    );

    const events = parseSSE(await live.text());
    expect(live.status).toBe(200);
    expect(events.map((e) => e.id)).toEqual(["2", "3"]);
    expect(events.map((e) => e.data.type)).toEqual(["text", "done"]);
    expect(events[0]!.data.data).toBe("two");
  });

  it("reconnects after completion and replays the full completed turn", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv().env);
    const res = await session.fetch(chatRequest());
    await res.body?.cancel();

    scriptSteps(async (_files, emit) => {
      await emit({ type: "text", data: "complete" });
      return { kind: "final", appended: [assistant("complete")] };
    });
    await drain(session, store);

    const live = await session.fetch(new Request("https://agent/live", { headers: { Authorization: "Bearer tok" } }));
    const events = parseSSE(await live.text());
    expect(live.status).toBe(200);
    expect(events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(events.map((e) => e.data.type)).toEqual(["text", "done"]);
    expect(events[0]!.data.data).toBe("complete");
  });

  it("relays persisted events to a connected client, scrubbing the API key", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv().env);
    const res = await session.fetch(chatRequest());

    scriptSteps(async (_files, emit) => {
      await emit({ type: "text", data: `hello ${API_KEY}` });
      return { kind: "final", appended: [assistant("hello")] };
    });
    await drain(session, store);

    const body = await res.text();
    expect(body).toContain('"type":"text"');
    expect(body).toContain("id: 1");
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain(API_KEY);
    const events = parseSSE(body);
    expect(events.at(-1)).toMatchObject({ id: "2", data: { type: "done", data: "" } });
  });

  it("reset cancels a persisted turn and its alarm", async () => {
    const { state, store, alarmAt } = fakeState();
    const session = new AgentSession(state, fakeEnv().env);
    const res = await session.fetch(chatRequest());
    await res.body?.cancel();
    await session.fetch(new Request("https://agent/reset", { method: "POST", headers: { Authorization: "Bearer tok" } }));
    expect(store.has("pendingTurn")).toBe(false);
    expect(alarmAt()).toBeNull();
  });
});

describe("ALARM_LOOP off: legacy path", () => {
  it("runs the turn in the /chat invocation and never arms an alarm", async () => {
    const { state, store, alarmAt } = fakeState();
    const session = new AgentSession(state, fakeEnv("false").env);
    turnMock.mockResolvedValue({
      newMessages: [{ role: "user", content: "build me a timer" }, assistant("legacy reply")],
      infraRequests: [],
    });

    const res = await session.fetch(chatRequest());
    await res.text(); // stream ends when the legacy build finishes

    expect(turnMock).toHaveBeenCalledTimes(1);
    expect(stepMock).not.toHaveBeenCalled();
    expect(store.has("pendingTurn")).toBe(false);
    expect(alarmAt()).toBeNull();
    expect((store.get("session") as any).messages.at(-1).content).toBe("legacy reply");
  });

  it("uses pendingTurn as the concurrency guard even after eviction", async () => {
    const { state, store } = fakeState();
    const { env } = fakeEnv("false");
    const session = new AgentSession(state, env);
    let release!: () => void;
    turnMock.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({ newMessages: [], infraRequests: [] });
        }),
    );
    const first = await session.fetch(chatRequest());
    const pending = store.get("pendingTurn") as PendingTurn;
    const second = await new AgentSession(state, env).fetch(chatRequest("again"));
    const body = (await second.json()) as any;
    expect(second.status).toBe(409);
    expect(second.headers.get("Retry-After")).toBe("2");
    expect(second.headers.get("Last-Event-ID")).toBe("0");
    expect(body).toMatchObject({ error: "A build is already in progress.", turnId: pending.turnId });
    release();
    await first.text();
  });

  it("clears pendingTurn on success so the next legacy chat is accepted", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv("false").env);
    turnMock
      .mockResolvedValueOnce({ newMessages: [{ role: "user", content: "build me a timer" }, assistant("first done")], infraRequests: [] })
      .mockResolvedValueOnce({ newMessages: [{ role: "user", content: "second" }, assistant("second done")], infraRequests: [] });

    const first = await session.fetch(chatRequest());
    await first.text();
    expect(store.has("pendingTurn")).toBe(false);

    const second = await new AgentSession(state, fakeEnv("false").env).fetch(chatRequest("second"));
    await second.text();
    expect(second.status).toBe(200);
    expect(store.has("pendingTurn")).toBe(false);
    expect((store.get("session") as any).messages.at(-1).content).toBe("second done");
  });

  it("clears pendingTurn on terminal error so the next legacy chat is accepted", async () => {
    const { state, store } = fakeState();
    const session = new AgentSession(state, fakeEnv("false").env);
    turnMock
      .mockRejectedValueOnce(new Error("model exploded"))
      .mockResolvedValueOnce({ newMessages: [{ role: "user", content: "retry" }, assistant("retry done")], infraRequests: [] });

    const first = await session.fetch(chatRequest());
    const body = await first.text();
    expect(body).toContain("model exploded");
    expect(store.has("pendingTurn")).toBe(false);

    const second = await new AgentSession(state, fakeEnv("false").env).fetch(chatRequest("retry"));
    await second.text();
    expect(second.status).toBe(200);
    expect(store.has("pendingTurn")).toBe(false);
    expect((store.get("session") as any).messages.at(-1).content).toBe("retry done");
  });
});

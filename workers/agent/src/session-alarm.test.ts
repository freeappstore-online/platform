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
    const { state } = fakeState();
    const { env } = fakeEnv();
    const first = await new AgentSession(state, env).fetch(chatRequest());
    await first.body?.cancel();
    // New instance = evicted DO: the in-memory flag is gone, storage is not.
    const second = await new AgentSession(state, env).fetch(chatRequest("again"));
    expect(second.status).toBe(429);
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
    const events = (store.get("turnEvents") as any).events;
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
    const types = (store.get("turnEvents") as any).events.map((e: any) => e.type);
    expect(types).toContain("deploy_status");
    expect(types.at(-1)).toBe("done");
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
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain(API_KEY);
    expect(body.trim().endsWith('data: {"type":"done","data":""}')).toBe(true);
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

  it("keeps the in-memory concurrency guard", async () => {
    const { state } = fakeState();
    const session = new AgentSession(state, fakeEnv("false").env);
    let release!: () => void;
    turnMock.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({ newMessages: [], infraRequests: [] });
        }),
    );
    const first = await session.fetch(chatRequest());
    const second = await session.fetch(chatRequest("again"));
    expect(second.status).toBe(429);
    release();
    await first.text();
  });
});

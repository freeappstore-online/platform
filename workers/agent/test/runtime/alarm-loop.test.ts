// The alarm-driven build loop (#41, epic #38) on a REAL Durable Object in
// workerd: real SQLite storage, real alarms, real D1. #41 was only tested
// against a mock DurableObjectState; this proves it survives what it exists
// for — the client leaving, the object being evicted between steps, the model
// failing, and a step hanging. The model is the scripted Anthropic stand-in in
// vitest.runtime.ts; everything else is the production code path.

import { runDurableObjectAlarm, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ALICE = { Authorization: "Bearer alice-session" };

type Pending = { heartbeat: number; phase: string } | undefined;

function stubFor(sessionId: string) {
  return env.SESSION.get(env.SESSION.idFromName(sessionId));
}

/** Start a turn the way the builder does, then close the tab straight away. */
async function startTurnAndLeave(sessionId: string, message: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO agent_sessions (session_id, user_id, name) VALUES (?, 'gh:1', 'New App')").bind(sessionId).run();
  const res = await exports.default.fetch(
    new Request(`https://agent.freeappstore.online/session/${sessionId}/chat`, {
      method: "POST",
      headers: { ...ALICE, "Content-Type": "application/json" },
      body: JSON.stringify({ message, aiConfig: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-test" } }),
    }),
  );
  expect(res.status).toBe(200);
  await res.body?.cancel(); // nobody is listening from here on
}

const pendingOf = (sessionId: string) =>
  runInDurableObject(stubFor(sessionId), (_instance, state) => state.storage.get<Pending>("pendingTurn"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read the turn and alarm state from the object's own storage. */
const doState = (sessionId: string) =>
  runInDurableObject(stubFor(sessionId), async (_i, state) => ({
    pending: await state.storage.get<NonNullable<Pending>>("pendingTurn"),
    alarm: await state.storage.getAlarm(),
  }));

/**
 * Wait for the turn to finish. Alarms fire by themselves in workerd; a due
 * alarm is nudged so tests don't sit out the step delay. With `evictBetween`,
 * the object is evicted every time it's parked between steps (alarm
 * scheduled, nothing in flight), so each step starts on a fresh instance.
 */
async function waitForTurnEnd(sessionId: string, { evictBetween = false, timeoutMs = 6000 } = {}) {
  let evictions = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { pending, alarm } = await doState(sessionId);
    if (!pending) return { evictions };
    if (alarm !== null) {
      if (evictBetween) {
        await evictDurableObject(stubFor(sessionId));
        evictions++;
      }
      await runDurableObjectAlarm(stubFor(sessionId));
    } else {
      await sleep(20);
    }
  }
  throw new Error(`turn ${sessionId} did not finish`);
}

async function sessionRow(sessionId: string) {
  return env.DB.prepare("SELECT messages, errors, input_tokens, output_tokens, ai_source FROM agent_sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<{ messages: string; errors: string | null; input_tokens: number; output_tokens: number; ai_source: string }>();
}

async function history(sessionId: string) {
  const res = await exports.default.fetch(new Request(`https://agent.freeappstore.online/session/${sessionId}/history`, { headers: ALICE }));
  return (await res.json()) as { messages: Array<{ role: string; content: string }> };
}

describe("alarm loop on a real Durable Object (#41)", () => {
  it("finishes a build with the tab closed: one step per alarm, persisted, mirrored to D1", async () => {
    await startTurnAndLeave("alarm-closed-tab", "build a timer");
    expect(await pendingOf("alarm-closed-tab")).toMatchObject({ phase: "main" });

    await waitForTurnEnd("alarm-closed-tab");

    expect(await pendingOf("alarm-closed-tab")).toBeUndefined();
    const files = await runInDurableObject(stubFor("alarm-closed-tab"), async (_i, state) => (await state.storage.get<{ files: Record<string, string> }>("session"))?.files);
    expect(files?.["web/src/App.tsx"]).toContain("Built");
    expect((await history("alarm-closed-tab")).messages.at(-1)).toMatchObject({ role: "assistant", content: "Done — built it." });

    const row = await sessionRow("alarm-closed-tab");
    expect(JSON.parse(row!.messages).at(-1).content).toBe("Done — built it.");
    expect(row).toMatchObject({ input_tokens: 200, output_tokens: 40, ai_source: "browser_key" });
  });

  it("resumes from storage when the object is evicted between every step", async () => {
    await startTurnAndLeave("alarm-evicted", "build a timer");

    const { evictions } = await waitForTurnEnd("alarm-evicted", { evictBetween: true });

    expect(evictions).toBeGreaterThanOrEqual(1);
    expect(await pendingOf("alarm-evicted")).toBeUndefined();
    expect((await history("alarm-evicted")).messages.at(-1)?.content).toBe("Done — built it.");
  });

  it("ends a turn the model fails, records why in D1, and frees the session", async () => {
    await startTurnAndLeave("alarm-overloaded", "overloaded please");

    await waitForTurnEnd("alarm-overloaded");

    expect(await pendingOf("alarm-overloaded")).toBeUndefined();
    const errors = JSON.parse((await sessionRow("alarm-overloaded"))!.errors ?? "[]") as Array<{ source: string; message: string }>;
    expect(errors.some((e) => e.source === "agent-stream" && /529|overloaded/i.test(e.message))).toBe(true);

    // Not left locked: the next turn is accepted.
    await startTurnAndLeave("alarm-overloaded", "build a timer");
    expect(await pendingOf("alarm-overloaded")).toMatchObject({ phase: "main" });
  });

  it("marks a turn stalled when its step was lost mid-flight, instead of hanging forever", async () => {
    await startTurnAndLeave("alarm-stalled", "hold this build");
    // A step is now in flight, blocked on the model. Age its heartbeat past the
    // stall budget, and schedule the next alarm the way a runtime retry would.
    await runInDurableObject(stubFor("alarm-stalled"), async (_i, state) => {
      const pending = (await state.storage.get<NonNullable<Pending>>("pendingTurn"))!;
      pending.heartbeat = Date.now() - 60 * 60 * 1000;
      await state.storage.put("pendingTurn", pending);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    // The isolate running that step is lost.
    await evictDurableObject(stubFor("alarm-stalled"));
    await fetch("https://control.test/release");

    await runDurableObjectAlarm(stubFor("alarm-stalled"));

    expect(await pendingOf("alarm-stalled")).toBeUndefined();
    const errors = JSON.parse((await sessionRow("alarm-stalled"))!.errors ?? "[]") as Array<{ source: string; message: string }>;
    expect(errors.at(-1)).toMatchObject({ source: "alarm" });
    expect(errors.at(-1)?.message).toMatch(/stalled/i);
    expect((await history("alarm-stalled")).messages.at(-1)?.content).toMatch(/^Error: Build stalled/);
  });

  it("refuses a second turn while one is in flight, with Retry-After", async () => {
    await startTurnAndLeave("alarm-busy", "hold this build");

    const second = await exports.default.fetch(
      new Request("https://agent.freeappstore.online/session/alarm-busy/chat", {
        method: "POST",
        headers: { ...ALICE, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "again", aiConfig: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-test" } }),
      }),
    );

    expect(second.status).toBe(409);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    await fetch("https://control.test/release");
    await waitForTurnEnd("alarm-busy");
  });
});

/** One `/live` read for the session's latest turn, parsed into SSE events. */
async function live(sessionId: string, lastEventId?: string) {
  const headers: Record<string, string> = { ...ALICE };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
  const res = await exports.default.fetch(new Request(`https://agent.freeappstore.online/session/${sessionId}/live`, { headers }));
  expect(res.status).toBe(200);
  const text = await res.text(); // the relay closes once the turn has ended
  const events = text
    .split("\n\n")
    .filter((block) => block.includes("data:"))
    .map((block) => {
      const id = Number(/^id: (\d+)$/m.exec(block)?.[1]);
      const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]) as { type: string; data: string };
      return { id, ...data };
    });
  return { events, lastEventIdHeader: res.headers.get("Last-Event-ID") };
}

describe("deploy turn on a real Durable Object (#38)", () => {
  it(
    "runs model → push_update → CI poll → follow-up through real alarms, with deploy status in the live stream",
    async () => {
      const id = "deploy-turn";
      await env.DB.prepare("INSERT OR IGNORE INTO apps (id, owner_login, created_at) VALUES ('dict', 'alice', 0)").run();
      // Open the existing app first (#12), so the session is bound to it and push_update is the right tool.
      const imported = await exports.default.fetch(
        new Request(`https://agent.freeappstore.online/session/${id}/import`, {
          method: "POST",
          headers: { ...ALICE, "Content-Type": "application/json" },
          body: JSON.stringify({ appId: "dict" }),
        }),
      );
      expect(imported.status).toBe(200);

      await startTurnAndLeave(id, "update the title");
      // push_update polls GitHub Actions after an 8s pause (DEPLOY_POLL_INTERVAL_MS).
      await waitForTurnEnd(id, { timeoutMs: 25_000 });

      // Every phase ran: main → main-infra → followup, and the turn ended cleanly.
      expect(await pendingOf(id)).toBeUndefined();
      const { events } = await live(id);
      const types = events.map((e) => e.type);
      const phases = events.filter((e) => e.type === "deploy_status").map((e) => (JSON.parse(e.data) as { phase: string }).phase);
      expect(phases).toEqual(["pushing", "building", "live"]);
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", data: JSON.stringify({ id: "tu_p", tool: "push_update" }) }));
      expect(types.at(-1)).toBe("done");
      expect(types).not.toContain("error");
      expect((await history(id)).messages.at(-1)).toMatchObject({ role: "assistant", content: "Updated and live." });

      // The deploy outcome is durable, and no LLM-phase failure was recorded.
      const row = await env.DB.prepare("SELECT deploy_state, errors FROM agent_sessions WHERE session_id = ?")
        .bind(id)
        .first<{ deploy_state: string; errors: string | null }>();
      expect(JSON.parse(row!.deploy_state)).toEqual({ phase: "live", appUrl: "https://dict.freeappstore.online" });
      const errors = JSON.parse(row!.errors ?? "[]") as Array<{ source: string }>;
      expect(errors.filter((e) => ["agent-empty", "agent-stream", "deploy"].includes(e.source))).toEqual([]);

      // What was pushed is now the baseline, so the next push sends only newer edits.
      const saved = await runInDurableObject(stubFor(id), (_i, state) =>
        state.storage.get<{ files: Record<string, string>; baselineFiles: Record<string, string> }>("session"),
      );
      expect(saved?.files["web/src/App.tsx"]).toContain("Updated title");
      expect(saved?.baselineFiles).toEqual(saved?.files);

      // A second update that changes nothing is skipped, not re-pushed and re-built.
      await startTurnAndLeave(id, "update the title again");
      await waitForTurnEnd(id, { timeoutMs: 25_000 });
      const second = await live(id);
      const secondPhases = second.events
        .filter((e) => e.type === "deploy_status")
        .map((e) => (JSON.parse(e.data) as { phase: string }).phase);
      expect(secondPhases).toEqual(["pushing", "live"]);
      expect(second.events.at(-1)?.type).toBe("done");
    },
    60_000,
  );
});

describe("stream replay from Last-Event-ID on a real Durable Object (#38)", () => {
  it("replays only the events after the one the client last saw", async () => {
    const id = "replay-turn";
    await startTurnAndLeave(id, "build a timer");
    await waitForTurnEnd(id);

    const full = await live(id);
    const ids = full.events.map((e) => e.id);
    expect(ids.length).toBeGreaterThan(2);
    expect(ids).toEqual(ids.map((_, i) => i + 1)); // 1..n, in order
    expect(full.events.at(-1)?.type).toBe("done");
    expect(full.lastEventIdHeader).toBe(String(ids.length));

    // Reconnecting after event 1: everything from 2 on, nothing repeated.
    const resumed = await live(id, "1");
    expect(resumed.events.map((e) => e.id)).toEqual(ids.slice(1));
    expect(resumed.events).toEqual(full.events.slice(1));

    // Reconnecting after the last event: nothing to replay.
    expect((await live(id, String(ids.length))).events).toEqual([]);

    // A header that isn't an event ID replays from the start rather than skipping.
    expect((await live(id, "garbage")).events.map((e) => e.id)).toEqual(ids);
  });
});

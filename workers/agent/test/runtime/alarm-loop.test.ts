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
async function waitForTurnEnd(sessionId: string, { evictBetween = false } = {}) {
  let evictions = 0;
  for (let i = 0; i < 300; i++) {
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

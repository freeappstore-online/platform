/** Durable Object: one instance per agent session.
 *  Stores conversation history, virtual filesystem, token usage, deploy status. */

import {
  emptyNoOutputError,
  MAX_LOOPS,
  MAX_RATE_LIMIT_RETRIES,
  type PreparedTurn,
  prepareTurn,
  runAgentStep,
  runAgentTurn,
  type SessionContext,
  stepDelayMs,
} from "./agent";
import type { StoreConfig } from "./config";
import { getConfig } from "./config";
import { corsHeaders, json } from "./cors";
import type { DeployEnv, DeployStatus } from "./deploy";
import type { Env } from "./index";
import { executeInfraTool } from "./infra-exec";
import type { AIConfig, Message, TokenUsage, ToolCall } from "./providers/types";
import { type PushSubscription, sendWebPush } from "./push";
import { APP_ARCHETYPES, type AppArchetype, getTemplateFiles } from "./template";

interface ErrorEntry {
  timestamp: string;
  source: string;
  message: string;
}

const MAX_MESSAGES = 200;
const MAX_FILES = 100;
const MAX_ERRORS = 50;

interface DeployLogEntry {
  timestamp: string;
  phase: string;
  detail: string;
}

interface SessionState {
  messages: Message[];
  files: Record<string, string>;
  tokenUsage: TokenUsage;
  deployStatus: DeployStatus | null;
  deployLog: DeployLogEntry[];
  appId: string | null;
  appName: string | null;
  errors: ErrorEntry[];
  ownerId: string | null;
  ownerLogin: string | null;
  tokenHash: string | null;
  tokenValidatedAt: number | null;
  sessionId: string | null;
  archetype?: AppArchetype;
}

const TOKEN_REVALIDATE_MS = 30 * 60 * 1000; // Re-verify token every 30 min

// ── Alarm-driven build loop (#41) ──
//
// With ALARM_LOOP=true a chat turn no longer runs as one long invocation.
// /chat persists a PendingTurn and arms an alarm; each alarm() runs ONE step
// (one model round-trip, or one infra tool), persists the result, and re-arms.
// A closed tab, an evicted DO or a transient upstream error loses at most the
// step in flight. Events go to a storage-backed log that the /chat stream
// relays, so a connected client still sees the build live.

/** An LLM step with no progress for this long is a stall (hung upstream). */
export const STALL_THRESHOLD_MS = 180_000;
/** Infra steps poll a GitHub Actions deploy for up to ~2.5 min on their own,
 *  so they get a longer budget before being called stalled. */
export const INFRA_STALL_THRESHOLD_MS = 600_000;
/** How long a /chat stream keeps relaying events before handing off to polling. */
const RELAY_MAX_MS = 15 * 60 * 1000;
const RELAY_POLL_MS = 300;
const MAX_TURN_EVENTS = 200;
const LATEST_TURN_ID_KEY = "latestTurnId";

type TurnPhase = "main" | "main-infra" | "followup" | "followup-infra";
type ChatBody = { message: string; aiConfig: AIConfig; archetype?: AppArchetype };
type AgentTurnResult = Awaited<ReturnType<typeof runAgentTurn>>;

export interface PendingTurn {
  turnId: string;
  message: string;
  mode?: "alarm" | "legacy";
  /** Includes the resolved API key; the record is deleted when the turn ends. */
  aiConfig: AIConfig;
  /** Caller's bearer token, needed by infra tools; deleted with the turn. */
  authHeader?: string;
  phase: TurnPhase;
  /** Which MAX_LOOPS iteration of the current LLM phase runs next. */
  loopIndex: number;
  retries: number;
  /** Index in session.messages where the current LLM phase's messages begin. */
  messagesCursor: number;
  /** Model-facing message list for the current LLM phase. */
  prepared: PreparedTurn | null;
  /** Messages produced by the current LLM phase (starts with its user prompt). */
  newMessages: Message[];
  anyToolCalls: boolean;
  infraQueue: ToolCall[];
  infraResults: { id: string; content: string }[];
  /** True once the main phase's messages are committed (mirrors the legacy path). */
  turnSaved: boolean;
  /** Date.now() at the last completed step. */
  heartbeat: number;
  startedAt: number;
}

interface TurnEventLog {
  turnId: string;
  nextSeq: number;
  events: { seq: number; type: string; data: string }[];
}

/** A provider StreamEvent, or a session-level event such as deploy_status. */
type TurnEvent = { type: string; data: string };

class StallError extends Error {}

interface LegacyTurnContext {
  pending: PendingTurn;
  body: ChatBody;
  session: SessionState;
  files: Map<string, string>;
  history: Message[];
  writer: WritableStreamDefaultWriter<Uint8Array>;
  config: StoreConfig;
  deployEnv: DeployEnv | null;
  authHeader?: string;
  sendSSE: (evt: TurnEvent) => Promise<void>;
  scrubKey: (s: string) => string;
}

function parseAppArchetype(value: unknown): AppArchetype | undefined {
  return typeof value === "string" && APP_ARCHETYPES.includes(value as AppArchetype) ? (value as AppArchetype) : undefined;
}

function turnEventsKey(turnId: string): string {
  return `turnEvents:${turnId}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StallError(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/** Extract a human-readable detail string from a deploy status event. */
function deployStatusDetail(status: DeployStatus): string {
  switch (status.phase) {
    case "provisioning": {
      const last = status.steps[status.steps.length - 1];
      return last ? `${last.name}: ${last.status} — ${last.detail}` : "Starting...";
    }
    case "pushing":
      return `Pushing code: ${status.progress}`;
    case "building":
      return `Building: ${status.deployUrl}`;
    case "live":
      return `Live at ${status.appUrl}`;
    case "error":
      return status.error;
  }
}

export class AgentSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private config: StoreConfig;
  private session: SessionState | null = null;
  /** Alarm path: events emitted since the last flush to storage. */
  private eventBuffer: { turnId: string; events: TurnEvent[]; lastFlush: number } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.config = getConfig(env.STORE);
  }

  private freshSession(overrides?: Partial<SessionState>): SessionState {
    const archetype = overrides?.archetype;
    return {
      messages: [],
      files: { ...getTemplateFiles(this.config, archetype) },
      tokenUsage: { input: 0, output: 0 },
      deployStatus: null,
      deployLog: [],
      appId: null,
      appName: null,
      errors: [],
      ownerId: null,
      ownerLogin: null,
      tokenHash: null,
      tokenValidatedAt: null,
      sessionId: null,
      archetype,
      ...overrides,
    };
  }

  private applyArchetypeToEmptySession(session: SessionState, archetype: AppArchetype | undefined): boolean {
    if (!archetype || this.config.store === "games") return false;
    if (session.archetype || session.messages.length > 0 || session.appId) return false;
    session.archetype = archetype;
    session.files = { ...getTemplateFiles(this.config, archetype) };
    return true;
  }

  private async load(): Promise<SessionState> {
    if (this.session) return this.session;
    const stored = await this.state.storage.get<SessionState>("session");
    if (stored) {
      this.session = stored;
    } else {
      this.session = this.freshSession();
      await this.save();
    }
    // Migrate old sessions
    if (!this.session.errors) this.session.errors = [];
    if (!this.session.deployLog) this.session.deployLog = [];
    if (this.session.ownerId === undefined) this.session.ownerId = null;
    if (this.session.ownerLogin === undefined) this.session.ownerLogin = null;
    if (this.session.tokenHash === undefined) this.session.tokenHash = null;
    if (this.session.tokenValidatedAt === undefined) this.session.tokenValidatedAt = null;
    if (this.session.sessionId === undefined) this.session.sessionId = null;
    this.session.archetype = parseAppArchetype(this.session.archetype);
    return this.session;
  }

  private async save(): Promise<void> {
    if (this.session) {
      await this.state.storage.put("session", this.session);
    }
  }

  /** Validate Bearer token, bind session to user on first authenticated call. */
  private async validateAuth(request: Request, requireAuth: boolean): Promise<{ userId: string | null; error: Response | null }> {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      if (requireAuth) {
        return { userId: null, error: json({ error: "Authorization required" }, 401, request, this.config.domain) };
      }
      return { userId: null, error: null };
    }

    const token = authHeader.slice(7);
    const session = await this.load();

    // If we already have an owner and the token hash matches, check TTL
    if (session.ownerId && session.tokenHash) {
      const hash = await hashToken(token);
      if (hash === session.tokenHash) {
        const age = session.tokenValidatedAt ? Date.now() - session.tokenValidatedAt : Infinity;
        if (age < TOKEN_REVALIDATE_MS) {
          return { userId: session.ownerId, error: null };
        }
        // TTL expired — fall through to re-validate
      }
    }

    // Validate token against the platform API. api.freeappstore.online is a
    // route-mapped Worker on this zone, so a plain same-zone fetch() would
    // bypass it — go through the PLATFORM service binding (host is ignored for
    // bound calls; only the path matters). Fall back to the public URL only
    // when the binding is absent (e.g. local dev / cross-zone).
    const res = this.env.PLATFORM
      ? await this.env.PLATFORM.fetch("https://backend/v1/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        })
      : await fetch("https://api.freeappstore.online/v1/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        });

    if (!res.ok) {
      return { userId: null, error: json({ error: "Invalid auth token" }, 401, request, this.config.domain) };
    }

    const user = (await res.json()) as { id: string; login: string };

    if (session.ownerId && session.ownerId !== user.id) {
      return { userId: null, error: json({ error: "Session belongs to another user" }, 403, request, this.config.domain) };
    }

    // Bind or refresh session auth
    session.ownerId = user.id;
    session.ownerLogin = user.login;
    session.tokenHash = await hashToken(token);
    session.tokenValidatedAt = Date.now();
    await this.save();

    return { userId: user.id, error: null };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, this.config.domain) });
    }

    await this.captureSessionMetadata(request, url);

    try {
      return await this.routeRequest(request, path);
    } catch (err) {
      console.error("Session error:", err);
      return json({ error: "Internal server error" }, 500, request, this.config.domain);
    }
  }

  // Capture session ID from the worker entry (needed for D1 writes)
  private async captureSessionMetadata(request: Request, url: URL): Promise<void> {
    const headerSessionId = request.headers.get("X-Session-Id");
    if (headerSessionId) {
      const requestedArchetype = parseAppArchetype(request.headers.get("X-App-Archetype") ?? url.searchParams.get("archetype"));
      const session = await this.load();
      let changed = false;
      if (!session.sessionId) {
        session.sessionId = headerSessionId;
        changed = true;
      }
      changed = this.applyArchetypeToEmptySession(session, requestedArchetype) || changed;
      if (changed) await this.save();
    }
  }

  private async routeRequest(request: Request, path: string): Promise<Response> {
    // Require auth on all endpoints that expose session data; only /status is public
    const auth = await this.validateAuth(request, path !== "/status");
    if (auth.error) return auth.error;

    const route = `${request.method} ${path}`;
    switch (route) {
      case "POST /chat":
        return this.handleChat(request);
      case "GET /live":
        return this.handleLive(request);
      case "GET /status":
        return this.handleStatus(request);
      case "GET /files":
        return this.handleListFiles(request);
      case "GET /history":
        return this.handleHistory(request);
      case "GET /errors":
        return this.handleErrors(request);
      case "POST /import":
        return this.handleImport(request);
      case "POST /reset":
        return this.handleReset(request);
      case "POST /push-subscribe":
        return this.handlePushSubscribe(request);
      default:
        return json({ error: "not found" }, 404, request, this.config.domain);
    }
  }

  /**
   * Persist a turn that failed validation before the agent ran (e.g. no API
   * key, bad provider). Without this the user's message + the error would live
   * only in the browser and get overwritten on reconnect, because /history
   * (DO-first) wouldn't know the turn happened. Every message must be saved.
   */
  private async recordErrorTurn(message: string, errorText: string): Promise<void> {
    const session = await this.load();
    session.messages.push({ role: "user", content: message.slice(0, 50_000) });
    session.messages.push({ role: "assistant", content: `Error: ${errorText}` });
    if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
    await this.save();
    await this.syncToD1();
  }

  /** POST /chat — stream an agent turn via SSE */
  private async handleChat(request: Request): Promise<Response> {
    const active = await this.activePendingTurn();
    if (active) {
      const session = await this.load();
      return this.jsonWithLastEventId(
        {
          error: "A build is already in progress.",
          turnId: active.turnId,
          status: this.computeDevStatus(session, true),
          liveUrl: "/live",
        },
        409,
        request,
        active?.turnId,
        { "Retry-After": "2" },
      );
    }
    // Validate before writing pendingTurn (early returns must not lock the session).
    const contentLength = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (contentLength > 200_000) {
      return json({ error: "Request too large (max 200KB)" }, 413, request, this.config.domain);
    }

    const body = await request.json<ChatBody>();

    if (!body.message || !body.aiConfig?.provider || !body.aiConfig?.model) {
      return json({ error: "message, aiConfig.provider, and aiConfig.model are required" }, 400, request, this.config.domain);
    }
    // apiKey may be empty if the worker resolved it from the platform vault
    // and injected it into the body before forwarding to the DO.
    if (!body.aiConfig.apiKey) {
      const msg = "No API key found. Add one in Profile → AI Providers, or configure it in the platform key vault.";
      await this.recordErrorTurn(body.message, msg);
      return json({ error: msg }, 400, request, this.config.domain);
    }

    const validProviders = ["anthropic", "openai", "google", "github", "openrouter"];
    if (!validProviders.includes(body.aiConfig.provider)) {
      const msg = `Invalid provider. Use: ${validProviders.join(", ")}`;
      await this.recordErrorTurn(body.message, msg);
      return json({ error: msg }, 400, request, this.config.domain);
    }

    // Truncate message to prevent storage abuse
    if (body.message.length > 50_000) {
      body.message = body.message.slice(0, 50_000);
    }
    const requestedArchetype = parseAppArchetype(body.archetype);
    if (requestedArchetype) {
      const session = await this.load();
      if (this.applyArchetypeToEmptySession(session, requestedArchetype)) await this.save();
    }

    if (this.env.ALARM_LOOP === "true") return this.startAlarmTurn(request, body);

    const session = await this.load();
    const files = new Map(Object.entries(session.files));
    const history = session.messages.slice();
    session.messages.push({ role: "user", content: body.message });
    if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
    await this.save();
    await this.syncToD1();

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();

    // Build deploy env directly from DO's env bindings (no header passing)
    const deployEnv = this.deployEnv();
    const config = this.config;
    const authHeader = request.headers.get("Authorization") || undefined;
    const now = Date.now();
    const pending: PendingTurn = {
      turnId: crypto.randomUUID(),
      message: body.message,
      mode: "legacy",
      aiConfig: body.aiConfig,
      authHeader,
      phase: "main",
      loopIndex: 0,
      retries: 0,
      messagesCursor: session.messages.length - 1,
      prepared: null,
      newMessages: [{ role: "user", content: body.message }],
      anyToolCalls: false,
      infraQueue: [],
      infraResults: [],
      turnSaved: false,
      heartbeat: now,
      startedAt: now,
    };
    const previousTurnId = await this.state.storage.get<string>(LATEST_TURN_ID_KEY);
    if (previousTurnId && previousTurnId !== pending.turnId) await this.state.storage.delete(turnEventsKey(previousTurnId));
    await this.state.storage.put("pendingTurn", pending);
    await this.state.storage.put(LATEST_TURN_ID_KEY, pending.turnId);
    await this.state.storage.put(turnEventsKey(pending.turnId), { turnId: pending.turnId, nextSeq: 1, events: [] } satisfies TurnEventLog);
    await this.state.storage.delete("turnEvents");

    // Scrub the user's API key from any error messages before streaming
    const apiKey = body.aiConfig.apiKey;
    const scrubKey = (s: string) => (apiKey && apiKey.length > 8 ? s.replaceAll(apiKey, "[REDACTED]") : s);
    const sendSSE = this.createLegacySseSender(writer, pending, scrubKey);

    // Run the agent in the background.
    // Anchor the promise to the DO's lifetime so Cloudflare keeps the instance
    // alive until the build completes, even if the client SSE stream closes.
    const buildPromise = this.runLegacyTurn({
      pending,
      body,
      session,
      files,
      history,
      writer,
      config,
      deployEnv,
      authHeader,
      sendSSE,
      scrubKey,
    });
    this.state.waitUntil(buildPromise);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(request, this.config.domain),
      },
    });
  }

  private createLegacySseSender(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    pending: PendingTurn,
    scrubKey: (s: string) => string,
  ): (evt: TurnEvent) => Promise<void> {
    const encoder = new TextEncoder();
    const emitLegacy = this.emitter(pending);
    return async (evt) => {
      const safe = evt.type === "error" || evt.type === "text" ? { ...evt, data: scrubKey(evt.data) } : evt;
      await emitLegacy(safe);
      await this.flushEvents();
      await writer.write(encoder.encode(`data: ${JSON.stringify(safe)}\n\n`)).catch(() => {});
    };
  }

  private async runLegacyTurn(ctx: LegacyTurnContext): Promise<void> {
    let turnSaved = false;
    try {
      const result = await this.runLegacyAgentTurn(ctx, ctx.history, ctx.body.message);
      await this.persistLegacyAgentResult(ctx, result);
      turnSaved = true;
      ctx.pending.turnSaved = true;

      if (result.infraRequests.length > 0) await this.runLegacyInfraAndFollowup(ctx, result.infraRequests);
      await ctx.sendSSE({ type: "done", data: "" });
    } catch (err) {
      this.logError("chat", ctx.scrubKey(String(err)));
      await ctx.sendSSE({ type: "error", data: String(err) });
      if (!turnSaved) await this.appendLegacyFailure(ctx, err);
      await this.syncToD1();
    } finally {
      await this.flushEvents();
      await this.clearPendingTurn(ctx.pending.turnId);
      ctx.writer.close().catch(() => {});
    }
  }

  private async runLegacyAgentTurn(ctx: LegacyTurnContext, history: Message[], message: string): Promise<AgentTurnResult> {
    try {
      return await runAgentTurn(
        ctx.body.aiConfig,
        history,
        message,
        ctx.files,
        ctx.writer,
        ctx.config,
        this.fileMapContext(ctx.session, ctx.files),
        this.env,
      );
    } catch (err) {
      this.logError("agent", String(err));
      throw err;
    }
  }

  private async persistLegacyAgentResult(ctx: LegacyTurnContext, result: AgentTurnResult): Promise<void> {
    this.logTerminalError(result.terminalError, ctx.scrubKey);
    ctx.session.messages = [...ctx.history, ...result.newMessages];
    if (ctx.session.messages.length > MAX_MESSAGES) ctx.session.messages = ctx.session.messages.slice(-MAX_MESSAGES);
    if (ctx.session.errors.length > MAX_ERRORS) ctx.session.errors = ctx.session.errors.slice(-MAX_ERRORS);
    this.trimFileMap(ctx.files);
    ctx.session.files = Object.fromEntries(ctx.files);
    await this.save();
    await this.syncToD1();
  }

  private async appendLegacyFailure(ctx: LegacyTurnContext, err: unknown): Promise<void> {
    try {
      ctx.session.messages.push({ role: "assistant", content: `Error: ${ctx.scrubKey(String(err))}` });
      if (ctx.session.messages.length > MAX_MESSAGES) ctx.session.messages = ctx.session.messages.slice(-MAX_MESSAGES);
      await this.save();
    } catch {
      /* best effort */
    }
  }

  private async runLegacyInfraAndFollowup(ctx: LegacyTurnContext, infraRequests: AgentTurnResult["infraRequests"]): Promise<void> {
    if (!ctx.deployEnv) {
      await ctx.sendSSE({ type: "error", data: "Server configuration error: deploy environment not available." });
      return;
    }

    const infraResults = await this.executeLegacyInfraRequests(ctx, infraRequests);
    ctx.session.messages.push({ role: "tool_result", content: "", toolResults: infraResults });
    ctx.session.files = Object.fromEntries(ctx.files);
    await this.save();
    await this.syncToD1();

    try {
      await this.runLegacyFollowup(ctx, infraResults);
    } catch (followUpErr) {
      this.logError("follow-up", ctx.scrubKey(String(followUpErr)));
      await this.syncToD1();
    }
  }

  private async runLegacyFollowup(ctx: LegacyTurnContext, infraResults: { id: string; content: string }[]): Promise<void> {
    const hasError = infraResults.some((r) => /error|fail|threw/i.test(r.content));
    const followUpPrompt = hasError
      ? "The tool action above returned an error. Analyze the error, fix the issue if possible, and retry the action. Do not ask the user — just fix it."
      : "The action completed. Summarize the result briefly for the user.";
    const followUp = await this.runLegacyAgentTurn(ctx, ctx.session.messages, followUpPrompt);

    this.logTerminalError(followUp.terminalError, ctx.scrubKey);
    ctx.session.messages.push(...followUp.newMessages);
    if (ctx.session.messages.length > MAX_MESSAGES) ctx.session.messages = ctx.session.messages.slice(-MAX_MESSAGES);
    ctx.session.files = Object.fromEntries(ctx.files);

    if (followUp.infraRequests.length > 0) {
      const retryResults = await this.executeLegacyInfraRequests(ctx, followUp.infraRequests);
      ctx.session.messages.push({ role: "tool_result", content: "", toolResults: retryResults });
      ctx.session.files = Object.fromEntries(ctx.files);
    }
    await this.save();
    await this.syncToD1();
  }

  private async executeLegacyInfraRequests(
    ctx: LegacyTurnContext,
    infraRequests: AgentTurnResult["infraRequests"],
  ): Promise<{ id: string; content: string }[]> {
    const results: { id: string; content: string }[] = [];
    for (const req of infraRequests) {
      const tc = req.toolCall;
      const toolResult = await this.executeLegacyInfraTool(ctx, tc);
      await ctx.sendSSE({ type: "tool_result", data: JSON.stringify({ id: tc.id, tool: tc.name }) });
      results.push({ id: tc.id, content: toolResult.slice(0, 3000) });
    }
    return results;
  }

  private async executeLegacyInfraTool(ctx: LegacyTurnContext, tc: ToolCall): Promise<string> {
    if (!ctx.deployEnv) return "Server configuration error: deploy environment not available.";
    try {
      return await executeInfraTool(tc, {
        appId: ctx.session.appId,
        ownerLogin: ctx.session.ownerLogin,
        authHeader: ctx.authHeader,
        files: ctx.files,
        env: ctx.deployEnv,
        config: ctx.config,
        onDeployStatus: (status) => this.handleLegacyDeployStatus(ctx, status),
        onAppDeployed: (id, name) => this.handleLegacyAppDeployed(ctx, id, name),
      });
    } catch (err) {
      return `Tool ${tc.name} threw an error: ${String(err)}`;
    }
  }

  private async handleLegacyDeployStatus(ctx: LegacyTurnContext, status: DeployStatus): Promise<void> {
    ctx.session.deployStatus = status;
    this.logDeploy(status.phase, deployStatusDetail(status));
    await this.state.storage.put("session", ctx.session);
    await ctx.sendSSE({ type: "deploy_status", data: JSON.stringify(status) });
    if (status.phase === "live") {
      this.sendPush("Your build is live!");
      this.syncToD1();
    } else if (status.phase === "error") {
      this.sendPush("Build failed");
      this.syncToD1();
    }
  }

  private async handleLegacyAppDeployed(ctx: LegacyTurnContext, id: string, name: string): Promise<void> {
    ctx.session.appId = id;
    ctx.session.appName = name;
    ctx.session.deployStatus = { phase: "provisioning", steps: [] };
    this.logDeploy("provisioning", `Starting deploy for ${name} (${id})`);
    await this.state.storage.put("session", ctx.session);
  }

  private fileMapContext(session: SessionState, files: Map<string, string>): SessionContext {
    return {
      appId: session.appId,
      appName: session.appName,
      fileCount: files.size,
      fileList: [...files.keys()].sort().join(", "),
    };
  }

  private logTerminalError(terminalError: string | undefined, scrubKey: (s: string) => string): void {
    if (!terminalError) return;
    const source = terminalError.startsWith("empty-no-output") ? "agent-empty" : "agent-stream";
    this.logError(source, scrubKey(terminalError));
  }

  private trimFileMap(files: Map<string, string>): void {
    const fileKeys = [...files.keys()];
    if (fileKeys.length <= MAX_FILES) return;
    const keep = new Set(fileKeys.slice(-MAX_FILES));
    for (const k of fileKeys) {
      if (!keep.has(k)) files.delete(k);
    }
  }

  // ── Alarm-driven turn (ALARM_LOOP=true) ──

  /** The persisted turn, if one is running. A turn whose heartbeat is older
   *  than any step budget is stale (its alarm was lost): fail it so it can't
   *  lock the session forever. */
  private async activePendingTurn(): Promise<PendingTurn | null> {
    const pending = await this.state.storage.get<PendingTurn>("pendingTurn");
    if (!pending) return null;
    if (pending.mode !== "legacy" && Date.now() - pending.heartbeat > INFRA_STALL_THRESHOLD_MS) {
      await this.load();
      await this.failTurn(pending, `Build stalled — no progress for >${INFRA_STALL_THRESHOLD_MS / 1000}s`, "alarm", true);
      return null;
    }
    return pending;
  }

  private sessionContext(session: SessionState): SessionContext {
    const names = Object.keys(session.files);
    return { appId: session.appId, appName: session.appName, fileCount: names.length, fileList: names.sort().join(", ") };
  }

  /** /chat under ALARM_LOOP: persist the turn, arm the alarm, relay events. */
  private async startAlarmTurn(request: Request, body: { message: string; aiConfig: AIConfig }): Promise<Response> {
    const session = await this.load();
    const history = session.messages.slice();
    session.messages.push({ role: "user", content: body.message });
    if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
    await this.save();
    await this.syncToD1();

    const now = Date.now();
    const pending: PendingTurn = {
      turnId: crypto.randomUUID(),
      message: body.message,
      mode: "alarm",
      aiConfig: body.aiConfig,
      authHeader: request.headers.get("Authorization") || undefined,
      phase: "main",
      loopIndex: 0,
      retries: 0,
      messagesCursor: session.messages.length - 1,
      prepared: prepareTurn(body.aiConfig, history, body.message, this.config, this.sessionContext(session)),
      newMessages: [{ role: "user", content: body.message }],
      anyToolCalls: false,
      infraQueue: [],
      infraResults: [],
      turnSaved: false,
      heartbeat: now,
      startedAt: now,
    };
    const previousTurnId = await this.state.storage.get<string>(LATEST_TURN_ID_KEY);
    if (previousTurnId && previousTurnId !== pending.turnId) await this.state.storage.delete(turnEventsKey(previousTurnId));
    await this.state.storage.put("pendingTurn", pending);
    await this.state.storage.put(LATEST_TURN_ID_KEY, pending.turnId);
    await this.state.storage.put(turnEventsKey(pending.turnId), { turnId: pending.turnId, nextSeq: 1, events: [] } satisfies TurnEventLog);
    await this.state.storage.delete("turnEvents"); // pre-#43 compatibility key; do not replay stale turns.
    await this.state.storage.setAlarm(now);

    const { readable, writable } = new TransformStream<Uint8Array>();
    // Not awaited: the relay lives as long as the client reads. If the client
    // goes away the write fails and the relay stops; the alarm carries on.
    void this.relayTurnEvents(pending.turnId, writable.getWriter(), this.parseLastEventId(request));
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Last-Event-ID": "0",
        ...corsHeaders(request, this.config.domain),
      },
    });
  }

  /** GET /live — reconnect to the current or most recent turn event log. */
  private async handleLive(request: Request): Promise<Response> {
    const latestTurnId = await this.state.storage.get<string>(LATEST_TURN_ID_KEY);
    const log = latestTurnId ? await this.loadTurnLog(latestTurnId) : await this.loadTurnLog();
    if (!log) {
      return json({ error: "No live turn is available." }, 404, request, this.config.domain);
    }

    const { readable, writable } = new TransformStream<Uint8Array>();
    void this.relayTurnEvents(log.turnId, writable.getWriter(), this.parseLastEventId(request));
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Last-Event-ID": String(Math.max(0, log.nextSeq - 1)),
        ...corsHeaders(request, this.config.domain),
      },
    });
  }

  private parseLastEventId(request: Request): number {
    const raw = request.headers.get("Last-Event-ID");
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private async loadTurnLog(turnId?: string): Promise<TurnEventLog | undefined> {
    if (turnId) return this.state.storage.get<TurnEventLog>(turnEventsKey(turnId));
    const latestTurnId = await this.state.storage.get<string>(LATEST_TURN_ID_KEY);
    if (latestTurnId) return this.state.storage.get<TurnEventLog>(turnEventsKey(latestTurnId));
    return this.state.storage.get<TurnEventLog>("turnEvents");
  }

  private async putTurnLog(log: TurnEventLog): Promise<void> {
    await this.state.storage.put(turnEventsKey(log.turnId), log);
  }

  private async currentEventSeq(turnId?: string): Promise<number> {
    const log = await this.loadTurnLog(turnId);
    return log ? Math.max(0, log.nextSeq - 1) : 0;
  }

  private async jsonWithLastEventId(
    data: unknown,
    status: number,
    request: Request,
    turnId?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Last-Event-ID": String(await this.currentEventSeq(turnId)),
        ...extraHeaders,
        ...corsHeaders(request, this.config.domain),
      },
    });
  }

  /** Stream a turn's persisted events to one SSE client until the turn ends. */
  private async relayTurnEvents(turnId: string, writer: WritableStreamDefaultWriter<Uint8Array>, afterSeq = 0): Promise<void> {
    const encoder = new TextEncoder();
    let seen = afterSeq;
    const deadline = Date.now() + RELAY_MAX_MS;
    // A cancelled stream rejects `closed` even when nothing is being written.
    let gone = false;
    writer.closed.catch(() => {
      gone = true;
    });
    try {
      for (;;) {
        if (gone) break;
        const pending = await this.state.storage.get<PendingTurn>("pendingTurn");
        const log = await this.loadTurnLog(turnId);
        if (log?.turnId === turnId) {
          for (const e of log.events) {
            if (e.seq <= seen) continue;
            await writer.write(encoder.encode(`id: ${e.seq}\ndata: ${JSON.stringify({ type: e.type, data: e.data })}\n\n`));
            seen = e.seq;
          }
        }
        // Events are flushed before pendingTurn is deleted, so this read saw them all.
        if (!pending || pending.turnId !== turnId || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
      }
    } catch {
      /* client disconnected — the alarm loop is unaffected */
    } finally {
      writer.close().catch(() => {});
    }
  }

  /** Emits provider stream events plus session events (deploy_status). */
  private emitter(pending: PendingTurn): (event: TurnEvent) => Promise<void> {
    const apiKey = pending.aiConfig.apiKey;
    const scrub = (s: string) => (apiKey && apiKey.length > 8 ? s.replaceAll(apiKey, "[REDACTED]") : s);
    return async (event) => {
      const safe = event.type === "error" || event.type === "text" ? { ...event, data: scrub(event.data) } : event;
      if (!this.eventBuffer || this.eventBuffer.turnId !== pending.turnId) {
        this.eventBuffer = { turnId: pending.turnId, events: [], lastFlush: Date.now() };
      }
      this.eventBuffer.events.push(safe);
      if (this.eventBuffer.events.length >= 20 || Date.now() - this.eventBuffer.lastFlush >= 250) await this.flushEvents();
    };
  }

  private async flushEvents(): Promise<void> {
    const buf = this.eventBuffer;
    if (!buf || buf.events.length === 0) return;
    const pending = buf.events.splice(0);
    buf.lastFlush = Date.now();
    const stored = await this.loadTurnLog(buf.turnId);
    const log: TurnEventLog = stored?.turnId === buf.turnId ? stored : { turnId: buf.turnId, nextSeq: 1, events: [] };
    for (const e of pending) {
      log.events.push({ seq: log.nextSeq++, type: e.type, data: e.data });
    }
    if (log.events.length > MAX_TURN_EVENTS) log.events = log.events.slice(-MAX_TURN_EVENTS);
    await this.state.storage.put(LATEST_TURN_ID_KEY, log.turnId);
    await this.putTurnLog(log);
  }

  /** Write the current LLM phase's messages into session.messages. */
  private commitPhaseMessages(session: SessionState, pending: PendingTurn): void {
    let all = [...session.messages.slice(0, pending.messagesCursor), ...pending.newMessages];
    if (all.length > MAX_MESSAGES) {
      const drop = all.length - MAX_MESSAGES;
      all = all.slice(drop);
      pending.messagesCursor = Math.max(0, pending.messagesCursor - drop);
    }
    session.messages = all;
  }

  private trimFiles(session: SessionState): void {
    const fileKeys = Object.keys(session.files);
    if (fileKeys.length > MAX_FILES) {
      const keep = new Set(fileKeys.slice(-MAX_FILES));
      for (const k of fileKeys) if (!keep.has(k)) delete session.files[k];
    }
  }

  /** Durable Object alarm: run one step of the pending turn, persist, re-arm. */
  async alarm(): Promise<void> {
    const pending = await this.state.storage.get<PendingTurn>("pendingTurn");
    if (!pending) return;
    const session = await this.load();

    const budget = pending.phase.endsWith("infra") ? INFRA_STALL_THRESHOLD_MS : STALL_THRESHOLD_MS;
    if (Date.now() - pending.heartbeat > budget) {
      await this.failTurn(
        pending,
        `Build stalled — no progress for >${budget / 1000}s (${pending.phase}, step ${pending.loopIndex})`,
        "alarm",
        true,
      );
      return;
    }

    let next: number | "done";
    try {
      next = await withTimeout(
        this.runTurnStep(session, pending),
        budget,
        `Build stalled — no progress for >${budget / 1000}s (${pending.phase}, step ${pending.loopIndex})`,
      );
    } catch (err) {
      if (err instanceof StallError) {
        await this.failTurn(pending, err.message, "alarm", true);
      } else if (pending.phase.startsWith("followup")) {
        // Follow-up failed — not critical, the infra action already completed.
        this.logError("follow-up", String(err));
        await this.completeTurn(pending);
      } else {
        await this.failTurn(pending, String(err), "chat", false);
      }
      return;
    }

    if (next === "done") {
      await this.completeTurn(pending);
      return;
    }
    pending.heartbeat = Date.now();
    await this.flushEvents();
    await this.save();
    await this.state.storage.put("pendingTurn", pending);
    await this.state.storage.setAlarm(Date.now() + next);
  }

  /** One step. Returns the delay before the next alarm, or "done". */
  private async runTurnStep(session: SessionState, pending: PendingTurn): Promise<number | "done"> {
    if (pending.phase === "main-infra" || pending.phase === "followup-infra") return this.runInfraStep(session, pending);

    const emit = this.emitter(pending);
    if (pending.loopIndex >= MAX_LOOPS || !pending.prepared) return this.finishLlmPhase(session, pending);

    const files = new Map(Object.entries(session.files));
    const step = await runAgentStep(pending.aiConfig, pending.prepared, files, this.config, emit, this.env);

    switch (step.kind) {
      case "threw":
        return this.finishLlmPhase(session, pending);
      case "stream_error":
        pending.newMessages.push({ role: "assistant", content: step.message });
        return this.finishLlmPhase(session, pending, step.message);
      case "rate_limited": {
        pending.retries++;
        if (pending.retries > MAX_RATE_LIMIT_RETRIES) {
          await emit({ type: "error", data: "Rate limited after 3 retries. Wait a minute or switch to a BYOK provider (gear icon)." });
          return this.finishLlmPhase(session, pending);
        }
        const retryDelay = 5000 * pending.retries;
        await emit({
          type: "text",
          data: `\n_Rate limited — retrying in ${retryDelay / 1000}s (attempt ${pending.retries}/${MAX_RATE_LIMIT_RETRIES})..._\n`,
        });
        return retryDelay; // same loopIndex
      }
    }

    pending.retries = 0;
    pending.prepared.messages.push(...step.appended);
    pending.newMessages.push(...step.appended);
    session.files = Object.fromEntries(files);
    this.commitPhaseMessages(session, pending);
    if (step.kind === "final") return this.finishLlmPhase(session, pending);
    pending.anyToolCalls = true;
    if (step.kind === "infra") {
      pending.infraQueue = step.infraRequests.map((r) => r.toolCall);
      return this.finishLlmPhase(session, pending);
    }
    pending.loopIndex++;
    return stepDelayMs(pending.aiConfig);
  }

  /** End of an LLM phase: record terminal errors, commit, then infra or done. */
  private async finishLlmPhase(session: SessionState, pending: PendingTurn, streamError?: string): Promise<number | "done"> {
    const terminal =
      streamError ??
      emptyNoOutputError(
        pending.newMessages,
        pending.infraQueue.map((toolCall) => ({ toolCall })),
        pending.anyToolCalls,
      );
    if (terminal) this.logError(terminal.startsWith("empty-no-output") ? "agent-empty" : "agent-stream", terminal);
    this.commitPhaseMessages(session, pending);
    if (session.errors.length > MAX_ERRORS) session.errors = session.errors.slice(-MAX_ERRORS);
    this.trimFiles(session);
    if (pending.phase === "main") pending.turnSaved = true;
    await this.save();
    await this.syncToD1();

    if (pending.infraQueue.length === 0) return "done";
    if (!this.deployEnv()) {
      await this.emitter(pending)({ type: "error", data: "Server configuration error: deploy environment not available." });
      return "done";
    }
    pending.phase = pending.phase === "main" ? "main-infra" : "followup-infra";
    pending.infraResults = [];
    return 0;
  }

  private deployEnv(): DeployEnv | null {
    return this.env.GITHUB_TOKEN ? { GITHUB_TOKEN: this.env.GITHUB_TOKEN, PLATFORM: this.env.PLATFORM, DB: this.env.DB } : null;
  }

  /** Execute the next queued infra tool (one per alarm). */
  private async runInfraStep(session: SessionState, pending: PendingTurn): Promise<number | "done"> {
    const emit = this.emitter(pending);
    const tc = pending.infraQueue[pending.infraResults.length];
    const deployEnv = this.deployEnv();
    if (tc && deployEnv) {
      const files = new Map(Object.entries(session.files));
      let toolResult: string;
      try {
        toolResult = await executeInfraTool(tc, {
          appId: session.appId,
          ownerLogin: session.ownerLogin,
          authHeader: pending.authHeader,
          files,
          env: deployEnv,
          config: this.config,
          onDeployStatus: async (status) => {
            session.deployStatus = status;
            this.logDeploy(status.phase, deployStatusDetail(status));
            await this.state.storage.put("session", session);
            await emit({ type: "deploy_status", data: JSON.stringify(status) });
            if (status.phase === "live" || status.phase === "error") {
              await this.sendPush(status.phase === "live" ? "Your build is live!" : "Build failed");
              await this.syncToD1();
            }
          },
          onAppDeployed: async (id, name) => {
            session.appId = id;
            session.appName = name;
            session.deployStatus = { phase: "provisioning", steps: [] };
            this.logDeploy("provisioning", `Starting deploy for ${name} (${id})`);
            await this.state.storage.put("session", session);
          },
        });
      } catch (err) {
        toolResult = `Tool ${tc.name} threw an error: ${String(err)}`;
      }
      session.files = Object.fromEntries(files);
      await emit({ type: "tool_result", data: JSON.stringify({ id: tc.id, tool: tc.name }) });
      pending.infraResults.push({ id: tc.id, content: toolResult.slice(0, 3000) });
      if (pending.infraResults.length < pending.infraQueue.length) return 0;
    }

    // All infra tools done: one tool_result message matching the assistant's calls.
    session.messages.push({ role: "tool_result", content: "", toolResults: pending.infraResults });
    if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
    await this.save();
    await this.syncToD1();
    if (pending.phase === "followup-infra") return "done";

    // Follow-up: let the AI react to the infra results (retry on error, else summarise).
    const hasError = pending.infraResults.some((r) => /error|fail|threw/i.test(r.content));
    const followUpPrompt = hasError
      ? "The tool action above returned an error. Analyze the error, fix the issue if possible, and retry the action. Do not ask the user — just fix it."
      : "The action completed. Summarize the result briefly for the user.";
    pending.phase = "followup";
    pending.loopIndex = 0;
    pending.retries = 0;
    pending.anyToolCalls = false;
    pending.infraQueue = [];
    pending.infraResults = [];
    pending.messagesCursor = session.messages.length;
    pending.prepared = prepareTurn(pending.aiConfig, session.messages, followUpPrompt, this.config, this.sessionContext(session));
    pending.newMessages = [{ role: "user", content: followUpPrompt }];
    return 0;
  }

  private async completeTurn(pending: PendingTurn): Promise<void> {
    await this.emitter(pending)({ type: "done", data: "" });
    await this.flushEvents();
    await this.clearPendingTurn(pending.turnId);
    await this.save();
    await this.syncToD1();
  }

  /** End a turn with an error that is durable in session.errors and D1. */
  private async failTurn(pending: PendingTurn, message: string, source: string, stalled: boolean): Promise<void> {
    const apiKey = pending.aiConfig.apiKey;
    const safe = apiKey && apiKey.length > 8 ? message.replaceAll(apiKey, "[REDACTED]") : message;
    const session = await this.load();
    this.logError(source, safe);
    await this.emitter(pending)({ type: "error", data: safe });
    // Legacy parity: a turn that failed before its first save gets the error
    // appended to the saved user message. A stall always gets one, so the chat
    // shows why the build stopped instead of just going quiet.
    if (stalled || !pending.turnSaved) {
      if (pending.phase === "main" && !pending.turnSaved) this.commitPhaseMessages(session, pending);
      session.messages.push({ role: "assistant", content: `Error: ${safe}` });
      if (session.messages.length > MAX_MESSAGES) session.messages = session.messages.slice(-MAX_MESSAGES);
    }
    await this.flushEvents();
    await this.clearPendingTurn(pending.turnId);
    await this.save();
    await this.syncToD1();
  }

  private async clearPendingTurn(turnId: string): Promise<void> {
    const current = await this.state.storage.get<PendingTurn>("pendingTurn");
    if (current?.turnId === turnId) await this.state.storage.delete("pendingTurn");
  }

  /** GET /status — current session state */
  private async handleStatus(request: Request): Promise<Response> {
    const session = await this.load();
    const turnActive = !!(await this.activePendingTurn());
    return json(
      {
        messageCount: session.messages.length,
        fileCount: Object.keys(session.files).length,
        tokenUsage: session.tokenUsage,
        deployStatus: session.deployStatus,
        appId: session.appId,
        archetype: session.archetype ?? "generic",
        appUrl: session.deployStatus?.phase === "live" ? session.deployStatus.appUrl : null,
        devStatus: this.computeDevStatus(session, turnActive),
      },
      200,
      request,
      this.config.domain,
    );
  }

  /**
   * Coarse "what is the agent doing right now" for the My Apps list.
   *   working   — a chat turn is actively streaming in this DO (pulsing)
   *   deploying — provisioning/building/pushing
   *   error     — last deploy failed (red)
   *   idle      — finished / never started / disconnected (blank)
   * `working` reflects an active turn (in memory, or a persisted alarm-loop
   * turn), which stays true while the turn runs server-side even after the
   * client disconnects — so the list shows the agent is still building after
   * you've switched apps.
   */
  private computeDevStatus(session: SessionState, turnActive: boolean): { state: string; detail: string } {
    const phase = session.deployStatus?.phase;
    const deploying = !!phase && !["live", "error"].includes(phase);
    if (turnActive) return { state: "working", detail: "Building…" };
    if (deploying) return { state: "deploying", detail: `Deploying — ${phase}` };
    if (phase === "error") {
      return { state: "error", detail: (session.deployStatus?.error || "Build failed").slice(0, 80) };
    }
    if (phase === "live") return { state: "idle", detail: "Live" };
    return { state: "idle", detail: session.messages.length > 1 ? "Idle" : "Empty" };
  }

  /** GET /files — list files with sizes */
  private async handleListFiles(request: Request): Promise<Response> {
    const session = await this.load();
    const files = Object.entries(session.files).map(([path, content]) => ({
      path,
      size: content.length,
    }));
    return json({ files }, 200, request, this.config.domain);
  }

  private logError(source: string, message: string) {
    if (!this.session) return;
    this.session.errors.push({ timestamp: new Date().toISOString(), source, message: message.slice(0, 500) });
    // Keep last 50 errors
    if (this.session.errors.length > 50) this.session.errors = this.session.errors.slice(-50);
  }

  /** Append a deploy event to the persistent log. */
  private logDeploy(phase: string, detail: string) {
    if (!this.session) return;
    this.session.deployLog.push({ timestamp: new Date().toISOString(), phase, detail: detail.slice(0, 500) });
    // Cap at 200 entries (a single deploy is ~5-10 events; keeps history across deploys)
    if (this.session.deployLog.length > 200) this.session.deployLog = this.session.deployLog.slice(-200);
  }

  /** Write transcript + deploy_log + errors to D1 for durable admin/debug persistence beyond DO eviction. */
  private async syncToD1(): Promise<void> {
    if (!this.session?.sessionId) return;
    try {
      await this.env.DB.prepare(
        `UPDATE agent_sessions SET messages = ?, deploy_log = ?, errors = ?, deploy_state = ?, updated_at = ? WHERE session_id = ?`,
      )
        .bind(
          JSON.stringify(this.session.messages),
          JSON.stringify(this.session.deployLog),
          JSON.stringify(this.session.errors),
          this.session.deployStatus ? JSON.stringify(this.session.deployStatus) : null,
          Date.now(),
          this.session.sessionId,
        )
        .run();
    } catch {
      // D1 sync is best-effort — DO storage is still authoritative while alive
    }
  }

  /** GET /errors — return server-side errors for debugging */
  private async handleErrors(request: Request): Promise<Response> {
    const session = await this.load();
    return json({ errors: session.errors }, 200, request, this.config.domain);
  }

  /** GET /history — return all conversation messages for restoring UI */
  private async handleHistory(request: Request): Promise<Response> {
    const session = await this.load();
    const history = session.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.map((tc) => ({
        name: tc.name,
        input: { path: tc.input.path, id: tc.input.id },
      })),
      toolResults: m.toolResults?.map((tr) => ({
        id: tr.id,
        content: tr.content.slice(0, 500),
      })),
    }));
    return json(
      {
        messages: history,
        appId: session.appId,
        appName: session.appName,
        deployStatus: session.deployStatus,
        deployLog: session.deployLog,
        errors: session.errors,
        tokenUsage: session.tokenUsage,
        archetype: session.archetype ?? "generic",
        fileCount: Object.keys(session.files).length,
      },
      200,
      request,
      this.config.domain,
    );
  }

  /** POST /import — load files from an existing GitHub repo into this session.
   *  Body: { appId: string }. Fetches the repo tree + file contents from
   *  GitHub and replaces the session's files so the agent can see and edit
   *  the existing code. */
  private async handleImport(request: Request): Promise<Response> {
    const body = await request.json<{ appId?: string }>();
    const appId = body?.appId;
    if (!appId || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(appId)) {
      return json({ error: "valid appId required" }, 400, request, this.config.domain);
    }
    const session = await this.load();
    if (session.appId && session.appId !== appId) {
      return json({ error: "session already linked to a different app" }, 409, request, this.config.domain);
    }

    const repo = `${this.config.org}/${appId}`;
    const files = await fetchRepoFiles(repo, this.config.agentName, this.env.GITHUB_TOKEN);
    if (!files) {
      return json({ error: `Could not read repo ${repo}` }, 404, request, this.config.domain);
    }

    session.files = files;
    session.appId = appId;
    session.appName = appId;
    session.deployStatus = { phase: "live", appUrl: `https://${appId}.${this.config.domain}` } as DeployStatus;
    await this.save();

    return json({ ok: true, fileCount: Object.keys(files).length }, 200, request, this.config.domain);
  }

  /** POST /reset — start over */
  private async handleReset(request: Request): Promise<Response> {
    const latestTurnId = await this.state.storage.get<string>(LATEST_TURN_ID_KEY);
    await this.state.storage.delete([
      "pendingTurn",
      "turnEvents",
      LATEST_TURN_ID_KEY,
      ...(latestTurnId ? [turnEventsKey(latestTurnId)] : []),
    ]);
    await this.state.storage.deleteAlarm();
    this.session = this.freshSession({
      ownerId: this.session?.ownerId ?? null,
      tokenHash: this.session?.tokenHash ?? null,
      tokenValidatedAt: this.session?.tokenValidatedAt ?? null,
      archetype: this.session?.archetype,
    });
    await this.save();
    return json({ ok: true }, 200, request, this.config.domain);
  }

  /** POST /push-subscribe — store push subscription for notifications */
  private async handlePushSubscribe(request: Request): Promise<Response> {
    const sub = await request.json<PushSubscription>();
    if (!sub.endpoint) {
      return json({ error: "endpoint required" }, 400, request, this.config.domain);
    }
    // Validate push endpoint is a known push service (prevents SSRF via push notifications)
    try {
      const host = new URL(sub.endpoint).hostname;
      const allowed =
        host.endsWith(".push.services.mozilla.com") ||
        host.endsWith(".google.com") ||
        host.endsWith(".googleapis.com") ||
        host.endsWith(".windows.com") ||
        host.endsWith(".push.apple.com") ||
        host.endsWith(".web.push.apple.com") ||
        host.endsWith(".notify.windows.com");
      if (!allowed) {
        return json({ error: "Invalid push endpoint domain" }, 400, request, this.config.domain);
      }
    } catch {
      return json({ error: "Invalid push endpoint URL" }, 400, request, this.config.domain);
    }
    await this.state.storage.put("pushSubscription", sub);
    return json({ ok: true }, 200, request, this.config.domain);
  }

  /** Send a push notification to the subscribed client */
  private async sendPush(_message: string): Promise<void> {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return;
    const sub = await this.state.storage.get<PushSubscription>("pushSubscription");
    if (!sub) return;
    try {
      await sendWebPush(sub, this.env.VAPID_PUBLIC_KEY, this.env.VAPID_PRIVATE_KEY);
    } catch {
      // Push failed (subscription expired, etc.) — don't crash the session
    }
  }
}

async function hashToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const IMPORTABLE_EXTS = new Set(["ts", "tsx", "js", "jsx", "json", "html", "css", "md", "yaml", "yml", "toml", "txt", "svg", "sh"]);
const SKIP_PATHS = ["node_modules/", "dist/"];
const SKIP_FILES = new Set(["pnpm-lock.yaml", "package-lock.json"]);

function isImportable(e: { path: string; type: string; size?: number }): boolean {
  if (e.type !== "blob") return false;
  if (e.path.startsWith(".") || SKIP_PATHS.some((p) => e.path.includes(p))) return false;
  if (SKIP_FILES.has(e.path)) return false;
  const ext = e.path.split(".").pop()?.toLowerCase() ?? "";
  return IMPORTABLE_EXTS.has(ext) && (e.size ?? 0) <= 100_000;
}

async function fetchRepoFiles(repo: string, agentName: string, token?: string): Promise<Record<string, string> | null> {
  const ghHeaders: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": agentName };
  if (token) ghHeaders.Authorization = `Bearer ${token}`;

  const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, { headers: ghHeaders });
  if (!treeRes.ok) return null;
  const treeData = (await treeRes.json()) as { tree: { path: string; type: string; size?: number }[] };
  const candidates = treeData.tree.filter(isImportable).slice(0, 80);
  if (candidates.length === 0) return null;

  const files: Record<string, string> = {};
  const rawHeaders = { ...ghHeaders, Accept: "application/vnd.github.raw+json" };
  for (let i = 0; i < candidates.length; i += 10) {
    const batch = candidates.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (f) => {
        const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}?ref=main`, { headers: rawHeaders });
        return fileRes.ok ? { path: f.path, content: await fileRes.text() } : null;
      }),
    );
    for (const r of results) if (r) files[r.path] = r.content;
  }
  return files;
}

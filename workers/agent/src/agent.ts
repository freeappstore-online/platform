/** Agent loop: send messages to AI, handle tool calls, repeat until done. */

import type { StoreConfig } from "./config";
import { type GatewayEnv, resolveGateway } from "./providers/ai-gateway";
import { AnthropicAdapter } from "./providers/anthropic";
import { GitHubModelsAdapter } from "./providers/github";
import { GoogleAdapter } from "./providers/google";
import { OpenAIAdapter } from "./providers/openai";
import type { AIConfig, Message, ProviderAdapter, StreamEvent, ToolCall, ToolResult } from "./providers/types";
import { getSystemPrompt } from "./template";
import { executeTool, getToolDefinitions, INFRA_TOOLS } from "./tools";

/**
 * Build the provider adapter, routing through Cloudflare AI Gateway when the
 * AI_GATEWAY_* env is configured (else direct to the provider). GitHub Models
 * is not a gateway provider, so it always calls direct.
 */
function createAdapter(config: AIConfig, gatewayEnv: GatewayEnv): ProviderAdapter {
  const providerTemp = config.temperature ?? 0.7;
  const providerMaxTokens = config.maxTokens ?? 16384;
  switch (config.provider) {
    case "anthropic":
      return new AnthropicAdapter(config.apiKey, config.model, providerTemp, providerMaxTokens, resolveGateway(gatewayEnv, "anthropic"));
    case "openai": {
      const gw = resolveGateway(gatewayEnv, "openai");
      return new OpenAIAdapter(config.apiKey, config.model, gw.baseUrl, providerTemp, providerMaxTokens, gw);
    }
    case "google":
      return new GoogleAdapter(config.apiKey, config.model, providerTemp, providerMaxTokens, resolveGateway(gatewayEnv, "google"));
    case "github":
      return new GitHubModelsAdapter(config.apiKey, config.model, providerTemp, providerMaxTokens);
    case "openrouter":
      return new OpenAIAdapter(config.apiKey, config.model, "https://openrouter.ai/api/v1", providerTemp, providerMaxTokens);
  }
}

export interface InfraRequest {
  toolCall: ToolCall;
}

export interface AgentTurnResult {
  newMessages: Message[];
  /** Infra tool calls that need server-side execution by the session */
  infraRequests: InfraRequest[];
  /**
   * Set when the turn ended due to a non-thrown error (e.g. Anthropic API
   * error stream event, empty-no-output).  The session must call logError and
   * syncToD1 on this field so the failure is durable.
   */
  terminalError?: string;
}

export interface SessionContext {
  appId: string | null;
  appName: string | null;
  fileCount: number;
  fileList: string;
}

/** Everything a turn needs before its first model call: the system prompt with
 *  session context, and the trimmed history with the user message appended. */
export interface PreparedTurn {
  systemPrompt: string;
  /** Messages sent to the model: cleaned history + the user message. */
  messages: Message[];
}

export function prepareTurn(
  config: AIConfig,
  conversationHistory: Message[],
  userMessage: string,
  storeConfig: StoreConfig,
  ctx?: SessionContext,
): PreparedTurn {
  // Build dynamic system prompt with session context
  let systemPrompt = getSystemPrompt(storeConfig);
  if (ctx) {
    const noun = storeConfig.noun;
    const Noun = storeConfig.Noun;
    const parts: string[] = [`\n\n## Current Session State`];
    parts.push(`- Files in project: ${ctx.fileCount} (${ctx.fileList.slice(0, 300)})`);
    if (ctx.appId) {
      parts.push(`- Deployed ${noun} ID: ${ctx.appId}`);
      parts.push(`- ${Noun} name: ${ctx.appName}`);
      parts.push(`- ${Noun} ID: ${ctx.appId} (deployed)`);
      parts.push(`- Use push_update (not deploy) for changes to this ${noun}.`);
    } else {
      parts.push(`- ${Noun} not yet deployed. Use deploy tool when ready.`);
    }
    systemPrompt += parts.join("\n");
  }

  // Trim conversation history to fit model context limits.
  // GitHub Models free tier limits vary by model:
  //   gpt-4.1: 8K tokens, gpt-4o/4o-mini: 16K+, others: varies
  // System prompt + 14 tools ≈ 2600 tokens.
  const isSmallContext = config.provider === "github" && config.model.includes("gpt-4.1");
  const MAX_HISTORY_CHARS = isSmallContext ? 6000 : config.provider === "github" ? 30000 : 80000;

  function msgSize(m: Message): number {
    let size = m.content?.length || 0;
    if (m.toolCalls) size += JSON.stringify(m.toolCalls).length;
    if (m.toolResults) size += JSON.stringify(m.toolResults).length;
    return size;
  }

  const trimmedHistory = [...conversationHistory];
  let historyChars = trimmedHistory.reduce((sum, m) => sum + msgSize(m), 0);

  // Drop messages from the front until under limit
  while (historyChars > MAX_HISTORY_CHARS && trimmedHistory.length > 2) {
    historyChars -= msgSize(trimmedHistory.shift()!);
  }

  // Fix orphaned messages: first message must be role=user.
  while (trimmedHistory.length > 1 && trimmedHistory[0].role !== "user") {
    trimmedHistory.shift();
  }

  // Fix orphaned tool_use/tool_result pairs:
  // Every assistant message with toolCalls must be followed by a tool_result.
  // Every tool_result must follow an assistant with toolCalls.
  // Drop any that don't have their pair.
  const cleaned: Message[] = [];
  for (let i = 0; i < trimmedHistory.length; i++) {
    const m = trimmedHistory[i];
    if (m.role === "assistant" && m.toolCalls?.length) {
      // Check if next message is tool_result
      const next = trimmedHistory[i + 1];
      if (next?.role === "tool_result") {
        cleaned.push(m, next);
        i++; // skip the tool_result
      }
      // else: orphaned tool_use — drop both
    } else if (m.role === "tool_result") {
      // Orphaned tool_result without preceding tool_use — drop it
    } else {
      cleaned.push(m);
    }
  }

  return { systemPrompt, messages: [...cleaned, { role: "user", content: userMessage }] };
}

export type Emit = (event: StreamEvent) => Promise<void>;

/** What one model round-trip produced. `appended` messages belong on both the
 *  model's message list and the turn's new messages, in order. */
export type StepOutcome =
  /** Rate limited before any output; retry the same step after a backoff. */
  | { kind: "rate_limited" }
  /** The provider streamed an error event: the turn ends with that error. */
  | { kind: "stream_error"; message: string }
  /** The provider call threw; an error event has already been emitted. */
  | { kind: "threw" }
  /** The model answered without tool calls: the turn is complete. */
  | { kind: "final"; appended: Message[] }
  /** File tools ran; loop again. */
  | { kind: "continue"; appended: Message[] }
  /** Infra tools requested; the session must execute them. */
  | { kind: "infra"; appended: Message[]; infraRequests: InfraRequest[] };

/**
 * One iteration of the agent loop: a single model call, then any file tools it
 * asked for. No delays, retries or loop bookkeeping — callers own those, so the
 * same step can run inside the legacy loop or one alarm at a time (#41).
 */
export async function runAgentStep(
  config: AIConfig,
  prepared: PreparedTurn,
  files: Map<string, string>,
  storeConfig: StoreConfig,
  emit: Emit,
  gatewayEnv: GatewayEnv = {},
): Promise<StepOutcome> {
  const adapter = createAdapter(config, gatewayEnv);
  const toolDefinitions = getToolDefinitions(storeConfig);
  let assistantText = "";
  const toolCalls: ToolCall[] = [];

  try {
    for await (const event of adapter.run(prepared.systemPrompt, prepared.messages, toolDefinitions)) {
      if (event.type === "done") continue;
      // Catch rate limit errors and retry after delay
      if (event.type === "error" && (event.data.includes("429") || event.data.includes("Rate limited"))) {
        return { kind: "rate_limited" };
      }
      await emit(event);
      if (event.type === "text") {
        assistantText += event.data;
      } else if (event.type === "tool_call") {
        toolCalls.push(JSON.parse(event.data));
      } else if (event.type === "error") {
        return { kind: "stream_error", message: event.data };
      }
    }
  } catch (err) {
    await emit({ type: "error", data: String(err) });
    return { kind: "threw" };
  }

  const assistantMsg: Message = {
    role: "assistant",
    content: assistantText,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
  if (toolCalls.length === 0) return { kind: "final", appended: [assistantMsg] };

  // Separate file tools (execute now) from infra tools (execute in session)
  const fileToolCalls = toolCalls.filter((tc) => !INFRA_TOOLS.has(tc.name));
  const infraToolCalls = toolCalls.filter((tc) => INFRA_TOOLS.has(tc.name));

  // Execute file tools
  const results: ToolResult[] = [];
  for (const tc of fileToolCalls) {
    const toolOutput = executeTool(tc, files, storeConfig);
    // Truncate large results in conversation history (e.g. read_file returning full file)
    const truncated = { ...toolOutput, content: toolOutput.content.slice(0, 1500) };
    results.push(truncated);
    // No `result` on the wire: tool output (file bodies, search hits) must
    // never reach the creator chat (#36). The client only needs `tool`.
    await emit({ type: "tool_result", data: JSON.stringify({ id: tc.id, tool: tc.name }) });
  }

  if (infraToolCalls.length > 0) {
    // Don't add the infra tool_result yet — the session builds it with real
    // results. File tool results (if any) go in now.
    const appended: Message[] = [assistantMsg];
    if (fileToolCalls.length > 0) appended.push({ role: "tool_result", content: "", toolResults: results });
    return { kind: "infra", appended, infraRequests: infraToolCalls.map((toolCall) => ({ toolCall })) };
  }

  // All tools were file tools — add results and continue the loop
  return { kind: "continue", appended: [assistantMsg, { role: "tool_result", content: "", toolResults: results }] };
}

/**
 * empty-no-output: tool calls occurred (model was in agentic mode) but the turn
 * ended with no infra requests and no write_file calls — the model read files
 * and then stalled instead of writing/deploying. A pure conversational reply
 * (no tool calls at all) is valid; we only flag when the model was mid-task
 * and failed to produce output.
 */
export function emptyNoOutputError(newMessages: Message[], infraRequests: InfraRequest[], anyToolCallsMade: boolean): string | undefined {
  if (infraRequests.length > 0 || !anyToolCallsMade) return undefined;
  const hasWriteFile = newMessages.some((m) => m.toolCalls?.some((tc) => tc.name === "write_file"));
  return hasWriteFile ? undefined : "empty-no-output: turn exited with tool calls but no write_file or infra requests";
}

/** Sent once when a not-yet-deployed app's turn stalls after only reading (#37). */
export const STALL_NUDGE = "Now write all the project files using write_file, then call deploy.";
/** Shown to the creator when the build still stalls after the nudge (#37). */
export const STALL_VISIBLE_ERROR = "The build stopped before writing any files — please try again.";

/**
 * What to do when an LLM phase ends in a final answer (#37). A turn on an app
 * that isn't deployed yet, which read files and then answered without writing
 * or requesting infra, is the stall from #37: nudge the model once, and if it
 * stalls again, give up visibly. Deployed apps are left alone, since a
 * read-then-answer turn there is usually a legitimate question.
 */
export function readOnlyStallAction(
  newMessages: Message[],
  anyToolCallsMade: boolean,
  appId: string | null | undefined,
  alreadyNudged: boolean,
): "nudge" | "give_up" | undefined {
  if (appId || !emptyNoOutputError(newMessages, [], anyToolCallsMade)) return undefined;
  return alreadyNudged ? "give_up" : "nudge";
}

/**
 * Append the stall nudge to both the model's messages and the turn's new
 * messages. A stalled final answer can be completely empty; providers reject an
 * empty assistant message before a user one, so that one is dropped first.
 */
export function appendStallNudge(modelMessages: Message[], newMessages: Message[]): void {
  for (const list of [modelMessages, newMessages]) {
    const last = list[list.length - 1];
    if (last?.role === "assistant" && !last.content && !last.toolCalls?.length) list.pop();
    list.push({ role: "user", content: STALL_NUDGE, internal: true });
  }
}

export const MAX_LOOPS = 25;
export const MAX_RATE_LIMIT_RETRIES = 3;

/** Delay before loop iteration > 0, to stagger API calls under rate limits. */
export function stepDelayMs(config: AIConfig): number {
  return config.provider === "github" ? 2000 : 500;
}

/**
 * Run one user turn through the agent loop in a single invocation (the legacy
 * path, used when ALARM_LOOP is off). Streams events via the writer, handles
 * file tool calls internally. Infra tools (deploy, push_update, etc.) are
 * collected and returned for the session to execute with env access.
 */
export async function runAgentTurn(
  config: AIConfig,
  conversationHistory: Message[],
  userMessage: string,
  files: Map<string, string>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  storeConfig: StoreConfig,
  ctx?: SessionContext,
  /** AI Gateway env (AI_GATEWAY_*). Omit/empty → direct provider calls. */
  gatewayEnv: GatewayEnv = {},
): Promise<AgentTurnResult> {
  const encoder = new TextEncoder();
  const prepared = prepareTurn(config, conversationHistory, userMessage, storeConfig, ctx);
  const newMessages: Message[] = [{ role: "user", content: userMessage }];
  const infraRequests: InfraRequest[] = [];
  // Track whether any tool calls occurred during this turn (used to detect
  // the empty-no-output failure: model read files then exited without writing)
  let anyToolCallsMade = false;
  let nudged = false;

  const send: Emit = async (event) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  let retries = 0;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    // Stagger API calls — wait between rounds to avoid rate limits
    if (loop > 0) await new Promise((r) => setTimeout(r, stepDelayMs(config)));

    const step = await runAgentStep(config, prepared, files, storeConfig, send, gatewayEnv);

    if (step.kind === "threw") break;
    if (step.kind === "stream_error") {
      newMessages.push({ role: "assistant", content: step.message });
      return { newMessages, infraRequests, terminalError: step.message };
    }
    // Auto-retry on rate limit with exponential backoff
    if (step.kind === "rate_limited") {
      retries++;
      if (retries > MAX_RATE_LIMIT_RETRIES) {
        await send({ type: "error", data: "Rate limited after 3 retries. Wait a minute or switch to a BYOK provider (gear icon)." });
        break;
      }
      const retryDelay = 5000 * retries; // 5s, 10s, 15s
      await send({
        type: "text",
        data: `\n_Rate limited — retrying in ${retryDelay / 1000}s (attempt ${retries}/${MAX_RATE_LIMIT_RETRIES})..._\n`,
      });
      await new Promise((r) => setTimeout(r, retryDelay));
      loop--; // retry same iteration
      continue;
    }
    retries = 0; // reset on success

    prepared.messages.push(...step.appended);
    newMessages.push(...step.appended);
    if (step.kind === "final") {
      const stall = readOnlyStallAction(newMessages, anyToolCallsMade, ctx?.appId, nudged);
      if (stall === "nudge") {
        nudged = true;
        appendStallNudge(prepared.messages, newMessages);
        continue;
      }
      if (stall === "give_up") {
        await send({ type: "error", data: STALL_VISIBLE_ERROR });
        newMessages.push({ role: "assistant", content: STALL_VISIBLE_ERROR });
      }
      break;
    }
    anyToolCallsMade = true;
    if (step.kind === "infra") {
      infraRequests.push(...step.infraRequests);
      break;
    }
  }

  if (infraRequests.length === 0) {
    await send({ type: "done", data: "" });
  }

  const terminalError = emptyNoOutputError(newMessages, infraRequests, anyToolCallsMade);
  return terminalError ? { newMessages, infraRequests, terminalError } : { newMessages, infraRequests };
}

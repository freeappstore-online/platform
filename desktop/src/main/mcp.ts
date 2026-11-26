import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BridgeError, type Hub, notOpen } from './hub.js';
import { APP_ID } from './security.js';

export interface McpDeps {
  hub: Hub;
  /** Opens (or focuses) the app in a desktop window. */
  openApp(appId: string): void;
  /** How long open_app waits for the app to register its tools. */
  openWaitMs?: number;
}

// Every tool carries a title and all four hints as explicit booleans, as in workers/mcp (#539).
// openWorldHint is false throughout: the tools only reach apps open on this machine.
const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const toolError = (value: string): CallToolResult => ({ ...text(value), isError: true });
const appId = z
  .string()
  .describe("The app's id, e.g. 'spreadsheet' for spreadsheet.freeappstore.online");
const badAppId = (id: string) =>
  toolError(`Invalid app_id "${id}": use the id from the app's URL, e.g. 'spreadsheet'.`);

export function createMcpServer({ hub, openApp, openWaitMs = 15_000 }: McpDeps): McpServer {
  const server = new McpServer({ name: 'FreeAppStore desktop', version: '0.1.0' });

  /** Runs a tool body, turning failures into MCP tool errors, and logs the call. */
  async function logged(
    tool: string,
    entry: { appId?: string; appTool?: string },
    run: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    let result: CallToolResult;
    try {
      result = await run();
    } catch (error) {
      result = toolError(
        error instanceof BridgeError ? error.message : `Unexpected error: ${String(error)}`,
      );
    }
    const first = result.content[0];
    hub.record({
      tool,
      ...entry,
      ok: !result.isError,
      ...(result.isError && first?.type === 'text' ? { error: first.text } : {}),
    });
    return result;
  }

  server.registerTool(
    'list_open_apps',
    {
      title: 'List open apps',
      description:
        'List the FreeAppStore apps currently offering tools on this computer: app id, window or tab title, where it is open (desktop window or browser tab) and its tool names. Empty when none is open with AI access on.',
      annotations: READ,
      inputSchema: {},
    },
    () =>
      logged('list_open_apps', {}, async () => {
        const apps = hub.openApps().map(({ appId, title, source, tools }) => ({
          app_id: appId,
          title,
          source,
          tools: tools.map((t) => t.name),
        }));
        return text(JSON.stringify(apps, null, 2));
      }),
  );

  server.registerTool(
    'app_tools',
    {
      title: "List an app's tools",
      description:
        'The tools an open app offers, with descriptions and JSON Schemas for their arguments. Call before app_call.',
      annotations: READ,
      inputSchema: { app_id: appId },
    },
    ({ app_id }) =>
      logged('app_tools', { appId: app_id }, async () => {
        if (!APP_ID.test(app_id)) return badAppId(app_id);
        const app = hub.find(app_id);
        if (!app) return toolError(notOpen(app_id));
        return text(JSON.stringify(app.tools, null, 2));
      }),
  );

  server.registerTool(
    'app_call',
    {
      title: "Run an app's tool",
      description:
        "Run one of an open app's tools on the data in that app, and return its result. Get tool names and argument schemas from app_tools. The app may change its data.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: {
        app_id: appId,
        tool: z.string().describe('Tool name from app_tools'),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments matching the tool's inputSchema"),
      },
    },
    ({ app_id, tool, args }) =>
      logged('app_call', { appId: app_id, appTool: tool }, async () => {
        const result = await hub.call(app_id, tool, args ?? {});
        return text(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      }),
  );

  server.registerTool(
    'open_app',
    {
      title: 'Open an app',
      description:
        'Open a FreeAppStore app in a FreeAppStore desktop window (or focus it if already open) and wait briefly for it to offer its tools. Desktop windows keep their own local data, separate from the browser.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { app_id: appId },
    },
    ({ app_id }) =>
      logged('open_app', { appId: app_id }, async () => {
        if (!APP_ID.test(app_id)) return badAppId(app_id);
        openApp(app_id);
        const app = await hub.waitFor(app_id, openWaitMs);
        if (!app) {
          return text(
            `Opened ${app_id} in a desktop window, but it has not offered any tools yet. It may still be loading (call list_open_apps again), or it may not support AI access.`,
          );
        }
        return text(
          `${app_id} is open. Tools: ${app.tools.map((t) => t.name).join(', ') || 'none'}. Call app_tools for their schemas.`,
        );
      }),
  );

  return server;
}

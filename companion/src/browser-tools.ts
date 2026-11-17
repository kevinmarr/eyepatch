import { McpServer } from "@modelcontextprotocol/server";
import { fromMcpServer } from "@agentclientprotocol/sdk/experimental/mcp-server";
import * as z from "zod";
import type { Bridge } from "./bridge.js";

type ToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

const text = (value: unknown): ToolResult => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

/** Run a browser call, turning failures into tool errors the agent can read. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String((e as Error).message ?? e) }] };
  }
}

/**
 * Browser tools served to the agent over the ACP connection itself
 * (MCP-over-ACP). Every call is forwarded to the extension, which runs it
 * against the user's active tab.
 */
export function createBrowserTools(bridge: Bridge) {
  return fromMcpServer(() => {
    const server = new McpServer({ name: "browser", version: "0.1.0" });

    server.registerTool(
      "get_active_tab",
      {
        description: "Get the URL, title and tab id of the browser tab the user is looking at.",
        inputSchema: z.object({}),
      },
      () => guarded(async () => text(await bridge.call("get_active_tab"))),
    );

    server.registerTool(
      "get_page_content",
      {
        description:
          "Read the active tab's DOM. Returns visible text or outerHTML of the element matching `selector` (default: document.body). Long output is truncated to maxChars.",
        inputSchema: z.object({
          selector: z.string().optional(),
          format: z.enum(["text", "html"]).default("html"),
          maxChars: z.number().int().positive().max(200_000).default(30_000),
        }),
      },
      (args) => guarded(async () => text(await bridge.call("get_page_content", args))),
    );

    server.registerTool(
      "query_selector_all",
      {
        description:
          "List elements in the active tab matching a CSS selector: tag, id, classes, a text snippet and an outerHTML snippet for each. Use it to find stable selectors before writing a mod.",
        inputSchema: z.object({
          selector: z.string(),
          limit: z.number().int().positive().max(200).default(20),
        }),
      },
      (args) => guarded(async () => text(await bridge.call("query_selector_all", args))),
    );

    server.registerTool(
      "run_js",
      {
        description:
          "Run JavaScript in the active tab and return the value of the last expression (JSON-serialized). world 'isolated' (default) sees the DOM only; 'main' also sees the page's own JS globals. Use for inspecting and for trying out a change before saving it as a mod. Effects are not persisted.",
        inputSchema: z.object({
          code: z.string(),
          world: z.enum(["isolated", "main"]).default("isolated"),
        }),
      },
      (args) => guarded(async () => text(await bridge.call("run_js", args))),
    );

    server.registerTool(
      "screenshot",
      {
        description:
          "Capture the visible part of the active tab as a PNG, scaled to CSS pixels (so image coordinates match getBoundingClientRect / elementFromPoint unless a scale factor is reported).",
        inputSchema: z.object({}),
      },
      () =>
        guarded(async () => {
          const shot = await bridge.call<{
            base64: string;
            width: number;
            height: number;
            viewportWidth: number | null;
            cssPxPerImagePx: number | null;
          }>("screenshot");
          const ratio = shot.cssPxPerImagePx ?? 1;
          const note =
            Math.abs(ratio - 1) < 0.01
              ? `Screenshot ${shot.width}x${shot.height}; 1 image px = 1 CSS px.`
              : `Screenshot ${shot.width}x${shot.height} of a ${shot.viewportWidth}px-wide viewport; multiply image coordinates by ${ratio.toFixed(3)} to get CSS px.`;
          return {
            content: [
              { type: "image", data: shot.base64, mimeType: "image/png" },
              { type: "text", text: note },
            ],
          };
        }),
    );

    server.registerTool(
      "get_console_logs",
      {
        description:
          "Read console output and uncaught errors from the active tab: messages from the page itself (world 'page') and from mods (world 'mods'). Capture runs from page load on pages that have JS mods; elsewhere it starts on the first call.",
        inputSchema: z.object({
          limit: z.number().int().positive().max(300).default(50),
          levels: z
            .array(z.enum(["error", "warn", "log", "info", "uncaught", "unhandledrejection"]))
            .optional()
            .describe("Only these levels (default: all)"),
        }),
      },
      (args) => guarded(async () => text(await bridge.call("get_console_logs", args))),
    );

    server.registerTool(
      "reload_tab",
      {
        description: "Reload the active tab (e.g. to see a JS mod run from a clean page).",
        inputSchema: z.object({}),
      },
      () => guarded(async () => text(await bridge.call("reload_tab"))),
    );

    return server;
  });
}

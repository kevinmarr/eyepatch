import { McpServer } from "@modelcontextprotocol/server";
import { fromMcpServer } from "@agentclientprotocol/sdk/experimental/mcp-server";
import * as z from "zod";
/** Calls the extension for one tab; see Chats.browserCall. */
export type BrowserCall = <T>(
  method: string,
  args: unknown,
  options: { timeoutMs?: number },
) => Promise<{ result: T; warning?: string }>;

type Screenshot = {
  base64: string;
  width: number;
  height: number;
  viewportWidth: number | null;
  cssPxPerImagePx: number | null;
};

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

type Content = ToolResult["content"];

/**
 * Call the extension and render the result, prefixing any warning it attached
 * (such as "the user navigated this tab") so the agent can't miss it.
 */
async function browser<T>(
  call: BrowserCall,
  method: string,
  args: unknown = {},
  render: (result: T) => Content = (r) => text(r).content,
  timeoutMs?: number,
): Promise<ToolResult> {
  return guarded(async () => {
    const { result, warning } = await call<T>(method, args, { timeoutMs });
    const content = render(result);
    return { content: warning ? [{ type: "text", text: warning }, ...content] : content };
  });
}

/**
 * Browser tools served to the agent over the ACP connection itself
 * (MCP-over-ACP). Every call is forwarded to the extension, which runs it
 * against the tab this conversation belongs to (even if the user has since
 * switched tabs).
 */
export function createBrowserTools(call: BrowserCall) {
  return fromMcpServer(() => {
    const server = new McpServer({ name: "browser", version: "0.1.0" });

    server.registerTool(
      "get_tab",
      {
        description:
          "Get the tab you're working on (the one this conversation belongs to): id, current URL and title, the URL when the message was sent, whether it has navigated since, and whether the user is still viewing it.",
        inputSchema: z.object({}),
      },
      () => browser(call, "get_tab"),
    );

    server.registerTool(
      "get_page_content",
      {
        description:
          "Read the tab's DOM. Returns visible text or outerHTML of the element matching `selector` (default: document.body). Long output is truncated to maxChars.",
        inputSchema: z.object({
          selector: z.string().optional(),
          format: z.enum(["text", "html"]).default("html"),
          maxChars: z.number().int().positive().max(200_000).default(30_000),
        }),
      },
      (args) => browser(call, "get_page_content", args),
    );

    server.registerTool(
      "query_selector_all",
      {
        description:
          "List elements in the tab matching a CSS selector: tag, id, classes, a text snippet and an outerHTML snippet for each. Use it to find stable selectors before writing a mod.",
        inputSchema: z.object({
          selector: z.string(),
          limit: z.number().int().positive().max(200).default(20),
        }),
      },
      (args) => browser(call, "query_selector_all", args),
    );

    server.registerTool(
      "run_js",
      {
        description:
          "Run JavaScript in the tab and return the value of the last expression (JSON-serialized). world 'isolated' (default) sees the DOM only; 'main' also sees the page's own JS globals. Use for inspecting and for trying out a change before saving it as a mod. Effects are not persisted.",
        inputSchema: z.object({
          code: z.string(),
          world: z.enum(["isolated", "main"]).default("isolated"),
        }),
      },
      (args) => browser(call, "run_js", args),
    );

    server.registerTool(
      "screenshot",
      {
        description:
          "Capture the visible part of the tab as a PNG, scaled to CSS pixels (so image coordinates match getBoundingClientRect / elementFromPoint unless a scale factor is reported). If the user has switched to another tab, they're asked to switch back and this waits until they do (or decline, in which case verify with the other tools instead).",
        inputSchema: z.object({}),
      },
      () =>
        browser<Screenshot>(
          call,
          "screenshot",
          {},
          (shot) => {
            const ratio = shot.cssPxPerImagePx ?? 1;
            const note =
              Math.abs(ratio - 1) < 0.01
                ? `Screenshot ${shot.width}x${shot.height}; 1 image px = 1 CSS px.`
                : `Screenshot ${shot.width}x${shot.height} of a ${shot.viewportWidth}px-wide viewport; multiply image coordinates by ${ratio.toFixed(3)} to get CSS px.`;
            return [
              { type: "image", data: shot.base64, mimeType: "image/png" },
              { type: "text", text: note },
            ];
          },
          // May wait for the user to switch back to the tab, which has no time limit.
          Infinity,
        ),
    );

    server.registerTool(
      "get_console_logs",
      {
        description:
          "Read console output and uncaught errors from the tab: messages from the page itself (world 'page') and from mods (world 'mods'). Capture runs from page load on pages that have JS mods; elsewhere it starts on the first call.",
        inputSchema: z.object({
          limit: z.number().int().positive().max(300).default(50),
          levels: z
            .array(z.enum(["error", "warn", "log", "info", "uncaught", "unhandledrejection"]))
            .optional()
            .describe("Only these levels (default: all)"),
        }),
      },
      (args) => browser(call, "get_console_logs", args),
    );

    server.registerTool(
      "reload_tab",
      {
        description: "Reload the tab (e.g. to see a JS mod run from a clean page).",
        inputSchema: z.object({}),
      },
      () => browser(call, "reload_tab"),
    );

    return server;
  });
}

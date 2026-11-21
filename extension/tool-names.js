// Readable titles for Eyepatch's own browser tools. Agents title tool calls
// with the raw MCP name ("mcp__eyepatch__run_js" from Claude,
// "eyepatch.run_js" from others); other tools keep the agent's title.

const BROWSER_TOOLS = {
  get_tab: { title: "Check the tab", icon: "globe" },
  get_page_content: { title: "Read the page", icon: "file-text" },
  query_selector_all: { title: "Find elements", icon: "search" },
  run_js: { title: "Run JavaScript in the page", icon: "code" },
  screenshot: { title: "Take a screenshot", icon: "camera" },
  get_console_logs: { title: "Read the console", icon: "square-terminal" },
  reload_tab: { title: "Reload the page", icon: "refresh-cw" },
  navigate: { title: "Open a page", icon: "square-arrow-out-up-right" },
};

/** The browser tool a call is for, if it's one of ours. */
export function browserTool(title) {
  const m = /eyepatch[^a-z0-9]{1,3}([a-z_]+)/i.exec(title ?? "");
  return m && BROWSER_TOOLS[m[1]] ? { name: m[1], ...BROWSER_TOOLS[m[1]] } : null;
}

/** A tool call's title as Markdown, e.g. "Find elements `.toc a`", "Open a page `https://…`". */
export function toolTitle(call) {
  const tool = browserTool(call?.title);
  if (!tool) return call?.title ?? call?.kind ?? "Tool";
  const arg = call.rawInput?.selector ?? call.rawInput?.url;
  return typeof arg === "string" && arg && !arg.includes("`") ? `${tool.title} \`${arg}\`` : tool.title;
}

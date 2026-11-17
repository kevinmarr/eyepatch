// Headless stand-in for the Chrome extension, for testing the companion:
//   npm start                      (in one terminal)
//   npm run fake-extension -- "make the page background red"
// Answers browser tool calls with canned data for https://example.com and
// auto-approves permission requests.
import { WebSocket } from "ws";

const PORT = Number(process.env.SITE_MODDER_PORT ?? 7457);
const prompt = process.argv.slice(2).join(" ") || "What page am I on? Use the browser tools.";
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "chrome-extension://fake" });

const page = { tabId: 1, url: "https://example.com/", title: "Example Domain" };
const html =
  '<body><div><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p><p><a href="https://iana.org/domains/example">More information...</a></p></div></body>';

const tools: Record<string, (p: any) => unknown> = {
  get_tab: () => ({ ...page, userIsViewingIt: true }),
  get_page_content: (p) => ({ length: html.length, truncated: false, content: p.format === "text" ? "Example Domain\nThis domain is for use in illustrative examples." : html }),
  query_selector_all: (p) => ({ total: 1, elements: [{ tag: "h1", classes: [], text: "Example Domain", html: "<h1>Example Domain</h1>", selector: p.selector }] }),
  run_js: () => "ok",
  screenshot: () => ({ base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", width: 1, height: 1, viewportWidth: 1, cssPxPerImagePx: 1 }),
  get_console_logs: () => ({ total: 0, entries: [] }),
  apply_mods: (p) => {
    console.log(`\n[mods] ${p.mods.map((m: any) => m.id + (m.error ? ` (${m.error})` : "")).join(", ") || "(none)"} changed=[${p.changed}]`);
    return { errors: {} };
  },
  reload_tab: () => "reloaded",
};

let prompted = false;
let pageCalls = 0;
ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  switch (msg.type) {
    case "status":
      if (msg.ready && !prompted) {
        prompted = true;
        console.log(`> ${prompt}\n`);
        ws.send(JSON.stringify({ type: "prompt", text: prompt, page }));
      }
      break;
    case "session_update": {
      const u = msg.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") process.stdout.write(u.content.text);
      else if (u.sessionUpdate === "tool_call") console.log(`\n[tool] ${u.title}`);
      break;
    }
    case "tool_call": {
      console.log(`\n[browser] ${msg.method} ${JSON.stringify(msg.params)}`);
      const fn = tools[msg.method];
      // FAKE_NAVIGATE=1 simulates the user navigating the tab after the first page tool call.
      const warning =
        process.env.FAKE_NAVIGATE && msg.method !== "apply_mods" && ++pageCalls > 1
          ? `Note: the user navigated this tab from ${page.url} to https://example.org/other since their message; this result is from the new page.`
          : undefined;
      ws.send(JSON.stringify(fn ? { type: "tool_result", id: msg.id, result: fn(msg.params), warning } : { type: "tool_result", id: msg.id, error: "unknown" }));
      break;
    }
    case "permission_request": {
      const allow = msg.options.find((o: any) => o.kind === "allow_once") ?? msg.options[0];
      console.log(`\n[permission] ${msg.toolCall?.title} -> ${allow.name}`);
      ws.send(JSON.stringify({ type: "permission_response", id: msg.id, optionId: allow.optionId }));
      break;
    }
    case "error":
      console.error(`\n[error] ${msg.message}`);
      break;
    case "turn_end":
      console.log(`\n\n[turn_end] ${msg.stopReason}`);
      setTimeout(() => process.exit(0), 500);
      break;
  }
});
ws.on("error", (e) => {
  console.error("Could not connect to the companion:", e.message);
  process.exit(1);
});

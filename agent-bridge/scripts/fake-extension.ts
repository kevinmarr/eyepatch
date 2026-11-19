// Headless stand-in for the Chrome extension, for testing Agent Bridge:
//   npm start                      (in one terminal)
//   npm run fake-extension -- "make the page background red"
// FAKE_AGENT=<registry id> picks (and installs) that agent for the tab first.
// FAKE_TABS='[{"tab":1,"agent":"claude-acp","prompt":"..."},{"tab":2,...}]'
// runs several tabs at once, each with its own chat.
// Answers browser tool calls with canned data for https://example.com and
// auto-approves permission requests.
import { WebSocket } from "ws";

const PORT = Number(process.env.SITE_MODDER_PORT ?? 7457);
type Tab = { tab: number; agent?: string; prompt: string };
const tabs: Tab[] = process.env.FAKE_TABS
  ? JSON.parse(process.env.FAKE_TABS)
  : [{ tab: 1, agent: process.env.FAKE_AGENT, prompt: process.argv.slice(2).join(" ") || "What page am I on? Use the browser tools." }];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: "chrome-extension://fake" });

const page = { url: "https://example.com/", title: "Example Domain" };
const html =
  '<body><div><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p><p><a href="https://iana.org/domains/example">More information...</a></p></div></body>';

const tools: Record<string, (p: any) => unknown> = {
  get_tab: (p) => ({ ...page, tabId: p.tabId, userIsViewingIt: true }),
  get_page_content: (p) => ({ length: html.length, truncated: false, content: p.format === "text" ? "Example Domain\nThis domain is for use in illustrative examples." : html }),
  query_selector_all: (p) => ({ total: 1, elements: [{ tag: "h1", classes: [], text: "Example Domain", html: "<h1>Example Domain</h1>", selector: p.selector }] }),
  run_js: () => "ok",
  screenshot: () => ({ base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", width: 1, height: 1, viewportWidth: 1, cssPxPerImagePx: 1 }),
  get_console_logs: () => ({ total: 0, entries: [] }),
  apply_mods: (p) => {
    console.log(`\n[mods] ${p.mods.map((m: any) => m.id + (m.error ? ` (${m.error})` : "")).join(", ") || "(none)"} changed=[${p.changed}] reloadTabs=${JSON.stringify(p.reloadTabs)}`);
    return { errors: {} };
  },
  reload_tab: () => "reloaded",
};

type TabState = { prompted: boolean; selecting: boolean; done: boolean; text: string };
const state = new Map<number, TabState>(tabs.map((t) => [t.tab, { prompted: false, selecting: false, done: false, text: "" }]));
const label = (tabId: number) => (tabs.length > 1 ? `[tab ${tabId}] ` : "");

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", tabs: tabs.map((t) => t.tab) }));
  for (const t of tabs) ws.send(JSON.stringify({ type: "open_chat", tabId: t.tab }));
});

let pageCalls = 0;
ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  const t = tabs.find((x) => x.tab === msg.tabId);
  const st = t && state.get(t.tab)!;
  switch (msg.type) {
    case "agents": {
      const ins = msg.agents.installing;
      if (ins) process.stdout.write(`\r[agents] ${ins.phase} ${ins.id} ${ins.version} ${ins.received ? Math.round(ins.received / 1e6) + " MB" : ""} ${ins.detail ?? ""}`.slice(0, 160).padEnd(80));
      else if (msg.agents.installError) {
        console.error(`\n[agents] install failed: ${msg.agents.installError.message}`);
        process.exit(1);
      }
      break;
    }
    case "chat": {
      if (!t || !st) break;
      const c = msg.chat;
      if (t.agent && c.agentId !== t.agent) {
        if (!st.selecting) {
          st.selecting = true;
          console.log(`${label(t.tab)}[chat] switching to ${t.agent}`);
          ws.send(JSON.stringify({ type: "agent_select", tabId: t.tab, id: t.agent }));
        }
        break;
      }
      if (!c.agentId) console.log(`${label(t.tab)}[chat] no agent chosen; set FAKE_AGENT=claude-acp`);
      if (c.ready && c.sessionId && !st.prompted) {
        st.prompted = true;
        console.log(`${label(t.tab)}> (${c.agent}, ${c.model?.current ?? "no model menu"}) ${t.prompt}`);
        ws.send(JSON.stringify({ type: "prompt", tabId: t.tab, text: t.prompt, page: { ...page, tabId: t.tab } }));
      }
      break;
    }
    case "session_update": {
      if (!st) break;
      const u = msg.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        if (tabs.length > 1) st.text += u.content.text;
        else process.stdout.write(u.content.text);
      } else if (u.sessionUpdate === "tool_call") console.log(`\n${label(msg.tabId)}[tool] ${u.title}`);
      break;
    }
    case "tool_call": {
      console.log(`\n${msg.params?.tabId != null ? label(msg.params.tabId) : ""}[browser] ${msg.method} ${JSON.stringify(msg.params).slice(0, 200)}`);
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
      console.log(`\n${label(msg.tabId)}[permission] ${msg.toolCall?.title} -> ${allow.name}`);
      ws.send(JSON.stringify({ type: "permission_response", id: msg.id, optionId: allow.optionId }));
      break;
    }
    case "error":
      console.error(`\n${label(msg.tabId)}[error] ${msg.message}`);
      break;
    case "turn_end":
      if (!st) break;
      if (st.text) console.log(`\n${label(msg.tabId)}${st.text.trim()}`);
      console.log(`\n${label(msg.tabId)}[turn_end] ${msg.stopReason}`);
      st.done = true;
      if ([...state.values()].every((x) => x.done)) setTimeout(() => process.exit(0), 500);
      break;
  }
});
ws.on("error", (e) => {
  console.error("Could not connect to Agent Bridge:", e.message);
  process.exit(1);
});

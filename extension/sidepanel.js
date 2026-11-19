import { modApplies } from "./match.js";
import { fillIcons, icon } from "./icons.js";

fillIcons();
// Focus rings are for keyboard use; Chrome also shows them after some clicks.
addEventListener("pointerdown", () => document.body.classList.add("pointer"), true);
addEventListener("keydown", (e) => e.key === "Tab" && document.body.classList.remove("pointer"), true);

const $ = (id) => document.getElementById(id);
// Each tab has its own side panel and chat; this is the tab this panel belongs to.
const TAB_ID = Number(new URLSearchParams(location.search).get("tab"));
const log = $("log");
const input = $("input");

let state = null;
let port = null;

// Rendering state for the current turn.
let agentMsg = null; // { el, text }
let thought = null; // { el, text }
let planEl = null;
const toolEls = new Map();
const permissionEls = new Map();

// ---------- connection to the service worker ----------

function connectPort() {
  port = chrome.runtime.connect({ name: `sidepanel:${TAB_ID}` });
  port.onMessage.addListener((msg) => {
    if (msg.type === "init") {
      resetLog();
      for (const e of msg.transcript) render(e);
      setState(msg.state);
    } else if (msg.type === "state") {
      setState(msg.state);
    } else if (msg.type === "event") {
      render(msg.event);
    } else if (msg.type === "history") {
      history = msg.items;
      renderMoreMenu();
    }
  });
  // The service worker can restart (e.g. extension reload); reconnect.
  port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
  reportVisibility();
}

// Lets the background skip notifications while the user is watching the panel.
function reportVisibility() {
  port?.postMessage({ type: "visibility", visible: document.visibilityState === "visible" });
}
document.addEventListener("visibilitychange", reportVisibility);
connectPort();

// ---------- header / banners ----------

const CHEVRON = icon("chevron-down", { cls: "chevron" });
$("new-menu-btn").innerHTML = CHEVRON;

function setState(s) {
  state = s;
  const c = s.bridge;
  const current = s.agents?.list.find((a) => a.id === s.agents.selected);
  const hasAgent = c.connected && !c.needsAgent && (c.agent || current);
  $("agent").hidden = !hasAgent;
  if (hasAgent) {
    const logo = current?.icon ? `<img class="agent-icon" src="${esc(current.icon)}" alt="" />` : "";
    $("agent").innerHTML = logo + `<span>${esc(c.agent ?? current.name)}</span>`;
  }
  const setup = c.connected && c.needsAgent;
  $("setup").hidden = !setup;
  document.body.classList.toggle("blocked", setup);
  $("stop").hidden = !c.busy;
  $("new-wrap").hidden = !hasAgent;
  $("new-menu-btn").hidden = !s.agents || s.agents.custom;
  renderNewMenu();
  renderMoreMenu();
  renderModel(s.model);
  $("send").disabled = !c.ready || c.busy || needsSignIn(s.auth);

  const banners = [];
  if (!c.connected) {
    banners.push(`Can't reach Agent Bridge. Make sure it's running.`);
  }
  if (hasAgent && needsSignIn(s.auth)) {
    banners.push(`${esc(s.auth.agent)} needs you to sign in.<button type="button" data-action="sign-in">Sign in</button>`);
  }
  if (!s.userScripts) {
    banners.push(
      `Turn on <b>Allow User Scripts</b> so mods can run.<button type="button" data-action="open-settings">Open settings</button>`,
    );
  }
  for (const [id, err] of Object.entries(s.modErrors ?? {})) {
    banners.push(`Mod <b>${esc(id)}</b> isn't running: ${esc(err)}`);
  }
  $("banners").innerHTML = banners
    .map((b) => {
      const [text, button = ""] = b.split(/(?=<button)/);
      return `<div class="banner"><span>${text}</span>${button}</div>`;
    })
    .join("");
}

$("banners").addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "open-settings") chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  if (action === "sign-in") openOptions(`#signin=${encodeURIComponent(state.bridge.agentId)}`);
});

let tabUrl = "";
async function updatePage() {
  const tab = await chrome.tabs.get(TAB_ID).catch(() => null);
  tabUrl = tab?.url ?? "";
  $("page").textContent = tabUrl ? `On: ${tabUrl}` : "";
  renderMoreMenu();
}
chrome.tabs.onUpdated.addListener((id, info) => id === TAB_ID && info.url && updatePage());
updatePage();

// ---------- composer ----------

function submit() {
  const text = input.value.trim();
  if (!text || !state?.bridge.ready || state.bridge.busy) return;
  port.postMessage({ type: "prompt", text });
  input.value = "";
}
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  submit();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
$("stop").addEventListener("click", () => port.postMessage({ type: "cancel" }));
$("new").addEventListener("click", () => port.postMessage({ type: "new_session" }));

// ---------- new chat menu: start the next chat with another agent ----------

let newMenuOpen = false;
function setNewMenu(open) {
  newMenuOpen = open;
  renderNewMenu();
}
$("new-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  setMoreMenu(null);
  setNewMenu(!newMenuOpen);
});
document.addEventListener("click", (e) => newMenuOpen && !e.target.closest("#new-menu") && setNewMenu(false));
document.addEventListener("keydown", (e) => e.key === "Escape" && newMenuOpen && setNewMenu(false));

function renderNewMenu() {
  const el = $("new-menu");
  const agents = state?.agents;
  const open = newMenuOpen && Boolean(agents) && !$("new-menu-btn").hidden && !$("new-wrap").hidden;
  el.hidden = !open;
  $("new-menu-btn").setAttribute("aria-expanded", String(open));
  if (!open) return;
  const installed = agents.list.filter((a) => a.installedVersion || a.id === agents.selected);
  const item = (a) => {
    const current = a.id === agents.selected;
    const logo = a.icon ? `<img src="${esc(a.icon)}" alt="" />` : `<span class="noicon"></span>`;
    const check = current ? icon("check", { cls: "check", label: "Current agent" }) : "";
    return `<button type="button" role="menuitem" data-agent="${esc(a.id)}" >${logo}<span>${esc(a.name)}</span>${check}</button>`;
  };
  el.innerHTML =
    installed.map(item).join("") +
    `<hr /><button type="button" role="menuitem" data-action="add">${icon("plus", { cls: "glyph" })}<span>Add more agents</span></button>`;
  el.querySelectorAll("[data-agent]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.agent;
      setNewMenu(false);
      port.postMessage(id === agents.selected ? { type: "new_session" } : { type: "agent_select", id });
    }),
  );
  el.querySelector("[data-action=add]").addEventListener("click", () => {
    setNewMenu(false);
    openOptions();
  });
}

function renderModel(model) {
  const el = $("model");
  el.hidden = !model?.options.length;
  if (el.hidden) return;
  const key = JSON.stringify(model);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = model.options
    .map((o) => `<option value="${esc(o.value)}" ${o.value === model.current ? "selected" : ""}>${esc(o.name)}</option>`)
    .join("");
  el.title = model.options.find((o) => o.value === model.current)?.description ?? "";
}
$("model").addEventListener("change", (e) => port.postMessage({ type: "set_model", value: e.target.value }));

// ---------- transcript rendering ----------

function resetLog() {
  log.innerHTML = `<div class="empty">Ask for a change to the page you're on, like “hide the sidebar” or “make this readable in dark mode”.</div>`;
  agentMsg = thought = planEl = null;
  toolEls.clear();
  permissionEls.clear();
}

function append(el) {
  log.querySelector(".empty")?.remove();
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(el);
  if (atBottom) log.scrollTop = log.scrollHeight;
  return el;
}

function div(cls, html) {
  const el = document.createElement("div");
  el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
}

/** A new non-text item ends the current text run, so text and tools interleave. */
function breakRun() {
  agentMsg = null;
  thought = null;
}

function render(e) {
  switch (e.type) {
    case "user_message":
      breakRun();
      planEl = null;
      append(div("msg user")).textContent = e.text;
      break;
    case "session_update":
      renderUpdate(e.update);
      break;
    case "permission_request":
      renderPermission(e);
      break;
    case "permission_resolved": {
      const el = permissionEls.get(e.id);
      if (el) {
        el.classList.add("resolved");
        el.querySelectorAll("button").forEach((b) => (b.disabled = true));
      }
      break;
    }
    case "tab_request":
      renderTabRequest(e);
      break;
    case "tab_request_resolved": {
      const el = permissionEls.get(e.id);
      if (el) {
        el.classList.add("resolved");
        el.querySelector(".buttons").textContent = e.accepted
          ? "Switched to the tab."
          : `Not switched (${e.reason ?? "declined"}); the agent will check another way.`;
      }
      break;
    }
    case "error":
      breakRun();
      append(div("msg error")).textContent = e.message;
      break;
    case "turn_end":
      breakRun();
      if (e.stopReason === "cancelled") append(div("msg note", "Stopped."));
      break;
    case "note":
      breakRun();
      append(div("msg note")).textContent = e.text;
      break;
  }
}

function renderUpdate(u) {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      if (u.content?.type !== "text") return;
      thought = null;
      if (!agentMsg) agentMsg = { el: append(div("msg agent")), text: "" };
      agentMsg.text += u.content.text;
      agentMsg.el.innerHTML = markdown(agentMsg.text);
      log.scrollTop = log.scrollHeight;
      break;
    }
    case "agent_thought_chunk": {
      if (u.content?.type !== "text") return;
      agentMsg = null;
      if (!thought) {
        const el = append(document.createElement("details"));
        el.className = "thought";
        el.innerHTML = "<summary>Thinking</summary><div></div>";
        thought = { el, text: "" };
      }
      thought.text += u.content.text;
      thought.el.querySelector("div").textContent = thought.text;
      break;
    }
    case "tool_call": {
      breakRun();
      const el = append(div("tool"));
      toolEls.set(u.toolCallId, el);
      renderTool(el, u);
      break;
    }
    case "tool_call_update": {
      const el = toolEls.get(u.toolCallId);
      if (el) renderTool(el, { ...el._data, ...stripNulls(u) });
      break;
    }
    case "plan": {
      breakRun();
      if (!planEl) planEl = append(document.createElement("ul"));
      planEl.className = "plan";
      planEl.innerHTML = u.entries
        .map((p) => `<li class="${esc(p.status)}">${esc(p.content)}</li>`)
        .join("");
      break;
    }
  }
}

function stripNulls(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}

const TOOL_ICONS = { pending: "○", in_progress: "◐", completed: "✓", failed: "✕" };

function renderTool(el, data) {
  el._data = data;
  const status = data.status ?? "pending";
  el.className = `tool ${status}`;
  el.innerHTML = `<span class="icon">${TOOL_ICONS[status] ?? "•"}</span><span>${esc(data.title ?? data.kind ?? "Tool")}</span>`;
}

function renderPermission(e) {
  breakRun();
  const el = append(div("permission"));
  permissionEls.set(e.id, el);
  el.innerHTML = `<div class="title">${esc(e.toolCall?.title ?? "The agent wants to run a tool")}</div><div class="buttons"></div>`;
  const buttons = el.querySelector(".buttons");
  for (const opt of e.options) {
    const b = document.createElement("button");
    b.textContent = opt.name;
    if (opt.kind === "allow_once") b.className = "primary";
    b.addEventListener("click", () => {
      port.postMessage({ type: "permission_response", id: e.id, optionId: opt.optionId });
      el.classList.add("resolved");
      buttons.querySelectorAll("button").forEach((x) => (x.disabled = true));
    });
    buttons.appendChild(b);
  }
}

function renderTabRequest(e) {
  breakRun();
  const el = append(div("permission"));
  permissionEls.set(e.id, el);
  el.innerHTML = `<div class="title">The agent wants to see “${esc(e.title || e.url)}” to ${esc(e.purpose)}.</div><div class="buttons"></div>`;
  const buttons = el.querySelector(".buttons");
  for (const [label, accept] of [["Switch to tab", true], ["Not now", false]]) {
    const b = document.createElement("button");
    b.textContent = label;
    if (accept) b.className = "primary";
    b.addEventListener("click", () => {
      port.postMessage({ type: "tab_response", id: e.id, accept });
      buttons.querySelectorAll("button").forEach((x) => (x.disabled = true));
    });
    buttons.appendChild(b);
  }
}

// ---------- setup ----------

const needsSignIn = (auth) => auth?.state === "unauthenticated";

/** Agents are installed and signed in on the Options page. */
function openOptions(hash = "") {
  chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash}`) });
}
$("setup-open").addEventListener("click", () => openOptions());

// ---------- ⋮ menu: this page's mods, past chats, settings ----------

let moreView = null; // null (closed), "main" or "chats" (every past chat)
let history = null; // past chats, newest first; fetched when the menu opens
const RECENT = 15;

function setMoreMenu(view) {
  if (view && !moreView) port.postMessage({ type: "history_list" });
  moreView = view;
  renderMoreMenu();
}
$("more").addEventListener("click", (e) => {
  e.stopPropagation();
  setNewMenu(false);
  setMoreMenu(moreView ? null : "main");
});
document.addEventListener("click", (e) => moreView && !e.target.closest("#more-menu") && setMoreMenu(null));
document.addEventListener("keydown", (e) => e.key === "Escape" && moreView && setMoreMenu(null));

const GEAR = icon("settings", { cls: "glyph" });
const BACK = icon("chevron-left", { cls: "glyph" });
const MORE = icon("chevron-right", { cls: "glyph" });

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderMoreMenu() {
  const el = $("more-menu");
  el.hidden = !moreView;
  $("more").setAttribute("aria-expanded", String(Boolean(moreView)));
  if (!moreView) return;
  const chats = (history ?? []).filter((c) => c.sessionId !== state?.sessionId);
  const chatItem = (c) =>
    `<button type="button" role="menuitem" class="chat" data-session="${esc(c.sessionId)}" title="${esc([c.agent, hostOf(c.url)].filter(Boolean).join(" · "))}">` +
    `<span class="title">${esc(c.title || "Untitled")}</span><span class="when">${esc(ago(c.updatedAt))}</span></button>`;

  let html = "";
  if (moreView === "chats") {
    html = `<button type="button" class="back" data-action="back">${BACK}<span>All chats</span></button>` + chats.map(chatItem).join("");
  } else {
    const mods = (state?.mods ?? []).filter((m) => !m.error && tabUrl && modApplies(m, tabUrl));
    if (mods.length) {
      html += `<div class="label">On this page</div>`;
      html += mods
        .map(
          (m) =>
            `<label class="mod" title="${esc(m.description ?? "")}"><span>${esc(m.name)}</span>` +
            `<input type="checkbox" class="switch" data-mod="${esc(m.id)}" ${m.enabled ? "checked" : ""} aria-label="${esc(m.name)}" /></label>`,
        )
        .join("");
      html += "<hr />";
    }
    if (chats.length) {
      // This site's chats first, then the rest; newest first within each.
      const here = hostOf(tabUrl);
      const recent = [...chats].sort((a, b) => (hostOf(b.url) === here) - (hostOf(a.url) === here)).slice(0, RECENT);
      html += `<div class="label">Recent chats</div>` + recent.map(chatItem).join("");
      if (chats.length > RECENT) html += `<button type="button" role="menuitem" class="all" data-action="all"><span>All chats</span>${MORE}</button>`;
      html += "<hr />";
    }
    html += `<button type="button" role="menuitem" data-action="settings">${GEAR}<span>Settings</span></button>`;
  }
  el.innerHTML = html;
}

$("more-menu").addEventListener("click", (e) => {
  const t = e.target.closest("[data-action], [data-session]");
  if (!t) return;
  e.stopPropagation();
  if (t.dataset.session) {
    setMoreMenu(null);
    port.postMessage({ type: "history_restore", sessionId: t.dataset.session });
  } else if (t.dataset.action === "all") setMoreMenu("chats");
  else if (t.dataset.action === "back") setMoreMenu("main");
  else if (t.dataset.action === "settings") {
    setMoreMenu(null);
    openOptions();
  }
});
$("more-menu").addEventListener("change", (e) => {
  const id = e.target.dataset.mod;
  if (id) port.postMessage({ type: "mod_set_enabled", id, enabled: e.target.checked });
});

// ---------- tiny, escape-first markdown ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function markdown(src) {
  const parts = src.split(/```[^\n]*\n?/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`;
      return part
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p) => `<p>${inline(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
    })
    .join("");
}

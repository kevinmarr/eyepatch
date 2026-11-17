const $ = (id) => document.getElementById(id);
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
  port = chrome.runtime.connect({ name: "sidepanel" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "init") {
      resetLog();
      for (const e of msg.transcript) render(e);
      setState(msg.state);
    } else if (msg.type === "state") {
      setState(msg.state);
    } else if (msg.type === "event") {
      render(msg.event);
    }
  });
  // The service worker can restart (e.g. extension reload); reconnect.
  port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
  chrome.windows.getCurrent().then((w) => port.postMessage({ type: "set_window", windowId: w.id }));
  reportVisibility();
}

// Lets the background skip notifications while the user is watching the panel.
function reportVisibility() {
  port?.postMessage({ type: "visibility", visible: document.visibilityState === "visible" });
}
document.addEventListener("visibilitychange", reportVisibility);
connectPort();

// ---------- header / banners ----------

function setState(s) {
  state = s;
  const c = s.companion;
  const dot = $("dot");
  dot.className = "dot" + (c.busy ? " busy" : c.ready ? " ready" : "");
  $("agent").textContent = !c.connected ? "Companion offline" : c.ready ? c.agent ?? "Agent" : "Starting agent…";
  $("stop").hidden = !c.busy;
  $("send").disabled = !c.ready || c.busy;

  const banners = [];
  if (!c.connected) {
    banners.push(
      `Start the local companion: <code>cd site-modder/companion && npm start</code>`,
    );
  }
  if (!s.userScripts) {
    banners.push(
      `Mods can't run yet. In <code>chrome://extensions</code>, open site-modder's <b>Details</b> and turn on <b>Allow User Scripts</b>.`,
    );
  }
  for (const [id, err] of Object.entries(s.modErrors ?? {})) {
    banners.push(`Mod <b>${esc(id)}</b> isn't running: ${esc(err)}`);
  }
  $("banners").innerHTML = banners.map((b) => `<div class="banner">${b}</div>`).join("");
}

async function updatePage() {
  const w = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
  $("page").textContent = tab?.url ? `On: ${tab.url}` : "";
}
chrome.tabs.onActivated.addListener(updatePage);
chrome.tabs.onUpdated.addListener((_id, info) => info.url && updatePage());
updatePage();

// ---------- composer ----------

function submit() {
  const text = input.value.trim();
  if (!text || !state?.companion.ready || state.companion.busy) return;
  chrome.windows.getCurrent().then((w) => port.postMessage({ type: "prompt", text, windowId: w.id }));
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

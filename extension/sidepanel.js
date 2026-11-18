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
  const c = s.bridge;
  const current = s.agents?.list.find((a) => a.id === s.agents.selected);
  const hasAgent = c.connected && !c.needsAgent && (c.agent || current);
  $("agent").hidden = !hasAgent;
  if (hasAgent) {
    const icon = current?.icon ? `<img class="agent-icon" src="${esc(current.icon)}" alt="" />` : "";
    $("agent").innerHTML = icon + esc(c.agent ?? current.name);
  }
  $("stop").hidden = !c.busy;
  $("new").hidden = !hasAgent;
  $("send").disabled = !c.ready || c.busy || needsSignIn(s.auth);
  renderAuth(s.auth, c);

  const banners = [];
  if (!c.connected) {
    banners.push(`Can't reach Agent Bridge. Make sure it's running.`);
  }
  if (c.ready && c.browserTools === false) {
    banners.push(
      `${esc(c.agent)} can't see web pages, only their address.<button type="button" data-action="change-agent">Change agent</button>`,
    );
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
  if (action === "change-agent") {
    chooseAgent = true;
    setState(state);
  }
});

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
  if (!text || !state?.bridge.ready || state.bridge.busy) return;
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

// ---------- account + sign-in ----------

let forceSignIn = false; // user chose "Sign in another way" while signed in
let forcedSignInStarted = false;
let signinKey = null; // what the sign-in card was last built for

const needsSignIn = (auth) => auth?.state === "unauthenticated";

function renderAuth(auth, c) {
  const picking = renderAgents(state.agents, c);
  // Leave "sign in another way" once a sign-in started from it has finished.
  if (forceSignIn && auth?.signIn) forcedSignInStarted = true;
  if (forceSignIn && forcedSignInStarted && !auth?.signIn && auth?.state === "authenticated") {
    forceSignIn = forcedSignInStarted = false;
  }
  const showSignin = !picking && Boolean(c.connected && !c.needsAgent && auth && (needsSignIn(auth) || auth.signIn || forceSignIn));
  document.body.classList.toggle("signing-in", showSignin || picking);
  $("signin").hidden = !showSignin;
  if (showSignin) renderSignin(auth);
  else signinKey = null;
  renderAccount(auth, c);
}

function renderSignin(auth) {
  const el = $("signin");
  const key = JSON.stringify([auth.signIn?.methodId, auth.methods, auth.error, auth.state, forceSignIn]);
  if (key === signinKey) {
    // Only the command output changed; don't rebuild (keeps typed input and focus).
    const out = el.querySelector(".output");
    if (out && auth.signIn) setOutput(out, auth.signIn.output);
    return;
  }
  signinKey = key;
  const agent = esc(auth.agent);
  const parts = [`<h2>Sign in to ${agent}</h2>`];

  if (auth.signIn) {
    const terminal = auth.methods.find((m) => m.id === auth.signIn.methodId)?.kind === "terminal";
    parts.push(
      `<p><strong>Signing in with ${esc(auth.signIn.name)}…</strong></p>`,
      `<p class="muted">Finish signing in in your browser. If you're shown a code, paste it here.</p>`,
    );
    if (terminal) {
      parts.push(
        `<pre class="output"></pre>`,
        `<form id="auth-input"><input name="text" autocomplete="off" placeholder="Paste code" aria-label="Paste code" /><button type="submit">Submit</button></form>`,
      );
    }
    parts.push(`<div><button id="auth-cancel" type="button">Cancel</button></div>`);
  } else {
    parts.push(
      forceSignIn
        ? `<p class="muted">Sign ${agent} in with one of its options below.</p>`
        : `<p class="muted">${agent} isn't signed in.</p>`,
      `<div><button id="auth-recheck" type="button">Check again</button></div>`,
    );
    for (const m of auth.methods) {
      parts.push(
        `<button class="method" type="button" data-method="${esc(m.id)}"><strong>${esc(m.name)}</strong>${m.description ? `<small>${esc(m.description)}</small>` : ""}</button>`,
      );
    }
    if (!auth.methods.length) {
      parts.push(`<p>${agent} doesn't offer a way to sign in from here; use its own tools.</p>`);
    }
    if (forceSignIn) parts.push(`<div><button id="auth-back" type="button">Back</button></div>`);
  }
  if (auth.error) parts.push(`<p class="error">${esc(auth.error)}</p>`);
  el.innerHTML = parts.join("");

  const out = el.querySelector(".output");
  if (out) setOutput(out, auth.signIn.output);
  el.querySelectorAll("[data-method]").forEach((b) =>
    b.addEventListener("click", () => port.postMessage({ type: "auth_start", methodId: b.dataset.method })),
  );
  el.querySelector("#auth-cancel")?.addEventListener("click", () => port.postMessage({ type: "auth_cancel" }));
  el.querySelector("#auth-back")?.addEventListener("click", () => {
    forceSignIn = false;
    setState(state);
  });
  el.querySelector("#auth-input")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    if (!input.value.trim()) return;
    port.postMessage({ type: "auth_input", text: input.value.trim() });
    input.value = "";
  });
  el.querySelector("#auth-recheck")?.addEventListener("click", (e) => {
    e.target.disabled = true;
    e.target.textContent = "Checking…";
    port.postMessage({ type: "auth_recheck" });
  });
  el.querySelector("#auth-input input")?.focus();
}

/** Command output, with URLs as links. */
function setOutput(pre, text) {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 20;
  pre.innerHTML = esc(text.trim() || "Starting…").replace(
    /https?:\/\/[^\s<>"']+/g,
    (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>`,
  );
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

let accountOpen = false;
$("agent").addEventListener("click", () => {
  if (!state?.auth) return;
  accountOpen = !accountOpen;
  setState(state);
});

function renderAccount(auth, c) {
  const el = $("account");
  const open = accountOpen && c.connected && auth && !document.body.classList.contains("signing-in");
  el.hidden = !open;
  $("agent").setAttribute("aria-expanded", String(Boolean(open)));
  if (!open) return;
  const lines = [];
  if (auth.state === "authenticated") {
    for (const a of auth.accounts) {
      const detail = [a.email && a.email !== a.label ? a.email : null, a.organization, a.description].filter(Boolean);
      lines.push(`<div><strong>${esc(a.label)}</strong>${detail.length ? `<div class="muted small">${esc(detail.join(" · "))}</div>` : ""}</div>`);
    }
    if (!auth.accounts.length) lines.push(`<div>Signed in to ${esc(auth.agent)}.</div>`);
  } else if (auth.state === "not_required") {
    lines.push(`<div>${esc(auth.agent)} doesn't need signing in.</div>`);
  }
  const buttons = [];
  if (state.agents && !state.agents.custom) buttons.push(`<button id="acct-agent" type="button">Change agent</button>`);
  if (auth.methods.length) buttons.push(`<button id="acct-switch" type="button">Sign in another way</button>`);
  if (auth.canLogout && auth.state === "authenticated") buttons.push(`<button id="acct-logout" type="button">Sign out</button>`);
  if (buttons.length) lines.push(`<div class="row">${buttons.join("")}</div>`);
  el.innerHTML = lines.join("");
  el.querySelector("#acct-agent")?.addEventListener("click", () => {
    chooseAgent = true;
    accountOpen = false;
    setState(state);
  });
  el.querySelector("#acct-switch")?.addEventListener("click", () => {
    forceSignIn = true;
    accountOpen = false;
    setState(state);
  });
  el.querySelector("#acct-logout")?.addEventListener("click", () => {
    const ok = confirm(
      `Sign out of ${auth.agent}?\n\nThis also signs you out of ${auth.agent} outside site-modder.`,
    );
    if (!ok) return;
    accountOpen = false;
    port.postMessage({ type: "auth_logout" });
  });
}

// ---------- agent picker ----------

let chooseAgent = false; // user chose "Change agent"
let pickedId = null; // what they clicked, until it's installed and selected
let moreOpen = false;

function fmtMB(n) {
  return `${Math.round(n / 1e6)} MB`;
}

/** Shows the picker when no agent is chosen (or the user asked to change). Returns whether it's showing. */
function renderAgents(agents, c) {
  const el = $("agents");
  if (agents && pickedId && agents.selected === pickedId && !agents.installing) {
    chooseAgent = false; // the choice went through
    pickedId = null;
  }
  if (agents?.installError) pickedId = null;
  const installingChoice = agents?.installing && !agents.installing.update;
  const show = Boolean(c.connected && agents && !agents.custom && (!agents.selected || chooseAgent || installingChoice));
  el.hidden = !show;
  if (!show) return false;

  const parts = [
    `<h2>${agents.selected ? "Change agent" : "Choose a coding agent"}</h2>`,
  ];
  const ins = agents.installing;
  if (ins && !ins.update) {
    const pct = ins.total ? Math.round((100 * ins.received) / ins.total) : null;
    const what = {
      downloading: `Downloading ${esc(ins.name)}${ins.received ? ` (${fmtMB(ins.received)}${ins.total ? ` of ${fmtMB(ins.total)}` : ""})` : ""}…`,
      verifying: `Checking the download…`,
      extracting: `Unpacking…`,
      npm: `Installing ${esc(ins.name)}…`,
    }[ins.phase];
    parts.push(
      `<div><p><strong>${what}</strong></p><progress ${pct != null && ins.phase === "downloading" ? `value="${pct}" max="100"` : ""}></progress>${ins.detail ? `<p class="muted small">${esc(ins.detail)}</p>` : ""}</div>`,
    );
  }
  if (agents.installError) {
    const name = agents.list.find((a) => a.id === agents.installError.id)?.name ?? agents.installError.id;
    parts.push(`<p class="error">Couldn't install ${esc(name)}: ${esc(agents.installError.message)}</p>`);
  }
  if (agents.registryError) {
    parts.push(`<p class="error">${esc(agents.registryError)}</p><div><button id="agents-retry" type="button">Try again</button></div>`);
  }

  const card = (a) => {
    const current = a.id === agents.selected;
    const tag = current
      ? "In use"
      : a.unavailable
        ? ""
        : a.installedVersion
          ? "Installed"
          : "Install";
    const disabled = Boolean(a.unavailable || ins || current);
    const icon = a.icon ? `<img src="${esc(a.icon)}" alt="" />` : `<span class="noicon"></span>`;
    return `<button class="agent-card${current ? " current" : ""}" type="button" data-agent="${esc(a.id)}" ${disabled ? "disabled" : ""}>${icon}<span class="text"><strong>${esc(a.name)}</strong></span><span class="tag">${tag}</span></button>`;
  };
  // Agents that can't be installed on this computer aren't worth listing.
  const installable = agents.list.filter((a) => !a.unavailable || a.id === agents.selected);
  const featured = installable.filter((a) => a.featured || a.id === agents.selected);
  const rest = installable.filter((a) => !featured.includes(a));
  parts.push(`<div class="agent-list">${featured.map(card).join("")}</div>`);
  if (rest.length) {
    parts.push(`<details id="agents-more" ${moreOpen ? "open" : ""}><summary>More agents (${rest.length})</summary><div class="agent-list">${rest.map(card).join("")}</div></details>`);
  }
  if (agents.selected && !ins) parts.push(`<div><button id="agents-back" type="button">Back</button></div>`);

  const scroll = el.scrollTop;
  el.innerHTML = parts.join("");
  el.scrollTop = scroll;
  el.querySelectorAll("[data-agent]").forEach((b) =>
    b.addEventListener("click", () => {
      pickedId = b.dataset.agent;
      port.postMessage({ type: "agent_select", id: b.dataset.agent });
    }),
  );
  el.querySelector("#agents-more")?.addEventListener("toggle", (e) => (moreOpen = e.target.open));
  el.querySelector("#agents-retry")?.addEventListener("click", () => port.postMessage({ type: "agents_refresh" }));
  el.querySelector("#agents-back")?.addEventListener("click", () => {
    chooseAgent = false;
    setState(state);
  });
  return true;
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

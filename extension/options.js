// Settings: setup checklist, installed agents (authenticate, uninstall), the
// agent catalog and every mod. Talks to the service worker, which relays to
// Agent Bridge. ?demo shows canned states without Chrome (see demo-settings.js).

import { fillIcons, icon, mark } from "./icons.js";
import { esc } from "./markdown.js";

const DEMO = new URLSearchParams(location.search).has("demo");
const demo = DEMO ? await import("./demo-settings.js") : null;

fillIcons();
document.getElementById("mark").outerHTML = mark({ size: 36 });
// Focus rings are for keyboard use; Chrome also shows them after some clicks.
addEventListener("pointerdown", () => document.body.classList.add("pointer"), true);
addEventListener("keydown", (e) => e.key === "Tab" && document.body.classList.remove("pointer"), true);

const $ = (id) => document.getElementById(id);

let state = null;
let port;
let picking = null; // agent id whose authentication methods are showing
let menuFor = null; // agent id whose ⋮ menu is open
let confirming = null; // "agent:<id>" or "mod:<id>" awaiting confirmation
// From the side panel's Authenticate button: options.html#signin=<agent id>
let signinFromLink = null;
// From a mod named in a chat: options.html#mod=<mod id>
let modFromLink = null;
let currentMod = null; // the mod a link showed, highlighted until the next click or key
let modLinkTimer;

function readHash() {
  const hash = new URLSearchParams(location.hash.slice(1));
  signinFromLink = hash.get("signin") ?? signinFromLink;
  if (!hash.has("mod")) return;
  modFromLink = hash.get("mod");
  history.replaceState(null, "", location.pathname + location.search);
  // A mod that never shows up (deleted, or not picked up yet) is forgotten.
  clearTimeout(modLinkTimer);
  modLinkTimer = setTimeout(() => (modFromLink = null), 5000);
}
readHash();
// The side panel reuses an open Settings tab by changing its hash.
addEventListener("hashchange", () => {
  readHash();
  if (state) rerender();
});

function connectPort() {
  port = DEMO ? demo.connect() : chrome.runtime.connect({ name: "options" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "state") render(msg.state);
    else if (msg.type === "mod_imported") imported(msg);
  });
  port.postMessage({ type: "color_scheme", dark: matchMedia("(prefers-color-scheme: dark)").matches });
  // The service worker was suspended or reloaded; reconnect.
  port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
}
connectPort();

const post = (msg) => port.postMessage(msg);
const openTab = (url) => (DEMO ? console.log("open", url) : chrome.tabs.create({ url }));
const rerender = () => render(state);

function render(s) {
  state = s;
  renderSetup(s);
  renderAgents(s);
  renderAddStatus(s);
  renderMods(s);
  renderAddDialog();
}

// ---------- setup ----------

// install.sh / install.ps1 download an Agent Bridge release and register it.
// They install the exact version this extension talks to; after that,
// Eyepatch updates Agent Bridge itself.
const PLATFORM = DEMO ? (new URLSearchParams(location.search).get("os") ?? "mac") : (await chrome.runtime.getPlatformInfo()).os;
const SCRIPTS = "https://raw.githubusercontent.com/kevinmarr/eyepatch/main";
const installCommand = (v) =>
  ({
    mac: `curl -fsSL ${SCRIPTS}/install.sh | EYEPATCH_VERSION=${v} sh`,
    linux: `curl -fsSL ${SCRIPTS}/install.sh | EYEPATCH_VERSION=${v} sh`,
    win: `$env:EYEPATCH_VERSION="${v}"; irm ${SCRIPTS}/install.ps1 | iex`,
  })[PLATFORM];
// Loaded unpacked (no store update URL): probably working on Eyepatch itself,
// with Agent Bridge running from source (see the README's Dev loop).
const UNPACKED = DEMO || !chrome.runtime.getManifest().update_url;
const DEV_INSTALL_COMMAND = "cd agent-bridge && bun install && bun run register:dev && bun run dev";
const START_COMMAND = "cd agent-bridge && bun run dev";

const commandBox = (command) =>
  `<div class="command"><code>${esc(command)}</code><button type="button" class="icon-btn" data-copy="${esc(command)}" aria-label="Copy command" title="Copy">${icon("copy", { size: 15 })}</button></div>`;

/** How to install, update or start Agent Bridge, for the first setup step. */
function bridgeStep(s) {
  const spinner = (text) => `<span class="waiting">${icon("loader-circle", { size: 15, stroke: 2.25, cls: "spin" })}${text}</span>`;
  const waiting = spinner("Waiting for Agent Bridge…");
  const command = installCommand(s.bridgeWanted);
  const install = command ? commandBox(command) : `<span class="muted">Agent Bridge runs on macOS, Windows and Linux.</span>`;
  switch (s.bridgeProblem) {
    case "dev_down":
      return { todo: "Start Agent Bridge", body: commandBox(START_COMMAND) + waiting };
    case "updating":
      return { todo: "Update Agent Bridge", body: spinner(`Updating to ${esc(s.bridgeWanted)}…`) };
    case "updating_extension":
      return { todo: "Update Eyepatch", body: spinner("Updating…") };
    case "extension_outdated":
      return {
        todo: "Update Eyepatch",
        body: `<span class="error-text">Agent Bridge ${esc(s.bridgeVersion)} needs a newer Eyepatch, and no update is available yet. Mods keep running.</span>`,
      };
    case "too_old":
      return { todo: "Update Agent Bridge", body: install + waiting };
    case "update_failed":
      return { todo: "Update Agent Bridge", body: `<span class="error-text">Couldn’t update to ${esc(s.bridgeWanted)}: ${esc(s.bridgeDetail)}</span>` + install + waiting };
  }
  // Anything else Chrome reported (e.g. it crashed on start) is worth showing.
  const problem = s.bridgeProblem && s.bridgeProblem !== "missing" ? `<span class="error-text">${esc(s.bridgeProblem)}</span>` : "";
  const dev = UNPACKED ? `<div class="from-source"><span class="muted">From source</span>${commandBox(DEV_INSTALL_COMMAND)}</div>` : "";
  return { todo: "Install Agent Bridge", body: install + dev + problem + waiting };
}

function renderSetup(s) {
  const hasAgent = Boolean(s.agents?.custom || s.agents?.list.some((a) => a.installedVersion));
  const steps = [
    { done: s.connected, name: "Agent Bridge running", ...bridgeStep(s) },
    { done: s.userScripts, name: "User scripts allowed", todo: "Allow user scripts" },
    { done: hasAgent, name: "Agent installed", todo: "Install an agent" },
  ];
  const done = steps.filter((x) => x.done).length;
  const complete = done === steps.length;
  $("setup").hidden = complete;
  $("setup-done").hidden = !complete;
  if (complete) {
    $("setup-done").innerHTML = steps.map((x) => `<li>${icon("circle-check", { size: 16 })}<span>${x.name}</span></li>`).join("");
    return;
  }
  $("setup-count").textContent = `${done} of ${steps.length}`;
  const bodies = [
    steps[0].body,
    `<div><button type="button" class="btn primary" data-action="user-scripts">Open extension settings</button></div>`,
    s.connected ? `<div><button type="button" class="btn primary" data-action="add-agent">Choose an agent</button></div>` : "",
  ];
  const html = steps
    .map((x, i) =>
      x.done
        ? `<li class="done"><span class="step-done">${icon("circle-check", { size: 18 })}</span><div class="main"><span class="name">${x.name}</span></div></li>`
        : `<li><span class="step">${i + 1}</span><div class="main"><span class="name">${x.todo}</span>${bodies[i]}</div></li>`,
    )
    .join("");
  if ($("steps").dataset.html !== html) $("steps").innerHTML = $("steps").dataset.html = html;
}

document.addEventListener("click", async (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "user-scripts") openTab(`chrome://extensions/?id=${DEMO ? "" : chrome.runtime.id}`);
  if (action === "add-agent") openAddDialog();
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    await navigator.clipboard.writeText(copy.dataset.copy).catch(() => {});
    copy.innerHTML = icon("check", { size: 15 });
    setTimeout(() => (copy.innerHTML = icon("copy", { size: 15 })), 1200);
  }
});

// ---------- installed agents ----------

const rowKeys = new Map(); // agent id -> what its row was last built from

const tile = (a, cls = "tile") => `<span class="${cls}">${a.icon ? `<img src="${esc(a.icon)}" alt="" />` : esc(a.name?.[0] ?? "?")}</span>`;

function installedAgents(s) {
  const agents = s.agents;
  if (!agents) return [];
  return agents.custom ? [{ id: "custom", name: s.auths.custom?.agent ?? "Custom agent", icon: null, custom: true }] : agents.list.filter((a) => a.installedVersion);
}

function renderAgents(s) {
  const el = $("agents");
  const agents = s.agents;
  $("agents-section").hidden = !s.connected || !agents;
  if ($("agents-section").hidden) return;
  $("add-btn").hidden = Boolean(agents.custom);
  $("add-btn").disabled = Boolean(agents.installing && !agents.installing.update);

  const installed = installedAgents(s);
  // Rebuild only rows whose content changed, so a code being typed isn't lost.
  const ids = installed.map((a) => a.id);
  if ([...el.children].map((d) => d.dataset.agent).join() !== ids.join()) {
    el.innerHTML = ids.map((id) => `<div class="agent" data-agent="${esc(id)}"></div>`).join("");
    rowKeys.clear();
  }
  for (const a of installed) {
    const box = el.querySelector(`[data-agent="${CSS.escape(a.id)}"]`);
    const auth = s.auths[a.id];
    if (signinFromLink === a.id && auth) {
      signinFromLink = null;
      startAuth(a, auth);
      requestAnimationFrame(() => box.scrollIntoView({ block: "center" }));
    }
    const key = JSON.stringify([a, agents.installing?.id === a.id && agents.installing, auth && { ...auth, signIn: auth.signIn && { ...auth.signIn, output: null } }, picking === a.id, menuFor === a.id, confirming === `agent:${a.id}`]);
    if (rowKeys.get(a.id) === key) {
      const out = box.querySelector(".terminal");
      if (out && auth?.signIn) setOutput(out, auth.signIn.output);
      continue;
    }
    rowKeys.set(a.id, key);
    box.innerHTML = agentRow(a, auth, agents);
    const out = box.querySelector(".terminal");
    if (out) setOutput(out, auth.signIn.output);
    box.querySelector(".code-form input")?.focus();
  }
}

function agentRow(a, auth, agents) {
  if (confirming === `agent:${a.id}`) {
    const others = installedAgents(state).filter((x) => x.id !== a.id);
    let consequence = others.length ? `Tabs using ${esc(a.name)} switch to ${esc(others[0].name)}.` : `Tabs using ${esc(a.name)} can’t chat until you install another agent.`;
    // An agent the user installed stays on their computer; Eyepatch just stops using it.
    const verb = a.command ? "Remove" : "Uninstall";
    if (a.command) consequence += " It stays installed on your computer.";
    return `<div class="confirm"><div class="main"><span class="name">${verb} ${esc(a.name)}?</span><span class="sub">${consequence}</span></div>
      <div class="actions"><button type="button" class="btn quiet" data-do="confirm-cancel">Cancel</button><button type="button" class="btn danger" data-do="uninstall">${verb}</button></div></div>`;
  }
  // Whatever the agent reports about the account, as it reports it.
  const account = (auth?.accounts ?? [])
    .map((x) => [x.label, x.email && x.email !== x.label ? x.email : null, x.organization].filter(Boolean).join(" · "))
    .join(", ");
  const unauthenticated = auth?.state === "unauthenticated";
  const updating = agents.installing?.update && agents.installing.id === a.id;
  const inFlow = Boolean(auth?.signIn) || picking === a.id;
  const failed = Boolean(auth?.error) && !inFlow;

  let sub = "";
  if (auth?.signIn) sub = `<span class="sub">Authenticating</span>`;
  else if (picking === a.id) sub = `<span class="sub">Choose how to authenticate</span>`;
  else if (auth?.restartPending) sub = `<span class="sub">${icon("loader-circle", { size: 13, stroke: 2.25, cls: "spin" })}Restarting after the current reply…</span>`;
  else if (auth?.checking) sub = `<span class="sub">${icon("loader-circle", { size: 13, stroke: 2.25, cls: "spin" })}Checking…</span>`;
  else if (failed) sub = `<span class="sub danger">Authentication failed: ${esc(auth.error)}</span>`;
  else if (unauthenticated) sub = `<span class="sub danger">Not authenticated</span>`;
  else if (updating) sub = `<span class="sub">${icon("loader-circle", { size: 13, stroke: 2.25, cls: "spin" })}Updating…</span>`;
  else if (account) sub = `<span class="sub">${esc(account)}</span>`;
  else if (a.command) sub = `<span class="sub mono" title="${esc(a.command)}">${esc(a.command)}</span>`;

  let actions = "";
  if (inFlow) {
    actions = `<button type="button" class="icon-btn lg" data-do="cancel" aria-label="Cancel authentication for ${esc(a.name)}" title="Cancel">${icon("x")}</button>`;
  } else {
    // Authenticated somewhere else (e.g. in a terminal): ask the agent again.
    if (unauthenticated && !auth.checking) actions += `<button type="button" class="btn quiet" data-do="recheck">Check again</button>`;
    if (failed && auth.methods.length) actions += `<button type="button" class="btn primary" data-do="auth">Try again</button>`;
    else if (unauthenticated && auth.methods.length) actions += `<button type="button" class="btn primary" data-do="auth">Authenticate</button>`;
    const items = [];
    if (auth?.methods.length && !unauthenticated) items.push(`<button type="button" class="menu-item" role="menuitem" data-do="auth">Reauthenticate</button>`);
    if (!a.custom) items.push(`<button type="button" class="menu-item danger" role="menuitem" data-do="ask-uninstall" ${agents.installing?.id === a.id ? "disabled" : ""}>${a.command ? "Remove" : "Uninstall"}</button>`);
    if (items.length) {
      actions +=
        `<div class="menu-anchor"><button type="button" class="icon-btn lg" data-do="menu" aria-label="More actions for ${esc(a.name)}" aria-haspopup="menu" aria-expanded="${menuFor === a.id}">${icon("ellipsis-vertical")}</button>` +
        (menuFor === a.id ? `<div class="menu row-menu" role="menu">${items.join("")}</div>` : "") +
        `</div>`;
    }
  }

  let flow = "";
  if (picking === a.id && !auth?.signIn) {
    flow =
      `<div class="inset-box list" role="list" aria-label="Authentication methods">` +
      auth.methods
        .map(
          (m) =>
            `<button type="button" class="option" role="listitem" data-method="${esc(m.id)}"><span class="main"><span class="name">${esc(m.name)}</span>${m.description ? `<span class="sub">${esc(m.description)}</span>` : ""}</span>${icon("chevron-right", { size: 15 })}</button>`,
        )
        .join("") +
      `</div>`;
  } else if (auth?.signIn) {
    const terminal = auth.methods.find((m) => m.id === auth.signIn.methodId)?.kind === "terminal";
    flow = terminal
      ? `<div class="inset-box"><pre class="terminal"></pre><form class="code-form"><input class="field" name="text" autocomplete="off" placeholder="Paste the code" aria-label="Paste the code" />` +
        `<button type="submit" class="send" aria-label="Submit code">${icon("arrow-up", { stroke: 2.25 })}</button></form></div>`
      : `<div class="inset-box"><div class="browser">${icon("loader-circle", { size: 15, stroke: 2.25, cls: "spin" })}<span>Continue in your browser</span></div></div>`;
  }

  return `<div class="row agent">${tile(a)}<div class="main"><span class="name">${esc(a.name)}</span>${sub}</div><div class="actions">${actions}</div></div>${flow}`;
}

function startAuth(a, auth) {
  menuFor = null;
  if (auth.methods.length === 1) post({ type: "auth_start", agentId: a.id, methodId: auth.methods[0].id });
  else picking = a.id;
  rerender();
}

$("agents").addEventListener("click", (e) => {
  const box = e.target.closest("[data-agent]");
  if (!box) return;
  const a = installedAgents(state).find((x) => x.id === box.dataset.agent);
  const auth = state.auths[a.id];
  const method = e.target.closest("[data-method]")?.dataset.method;
  if (method) {
    picking = null;
    post({ type: "auth_start", agentId: a.id, methodId: method });
    return rerender();
  }
  const what = e.target.closest("[data-do]")?.dataset.do;
  if (!what) return;
  e.stopPropagation();
  if (what === "menu") menuFor = menuFor === a.id ? null : a.id;
  else if (what === "auth") return startAuth(a, auth);
  else if (what === "recheck") post({ type: "auth_recheck", agentId: a.id });
  else if (what === "cancel") {
    if (auth?.signIn) post({ type: "auth_cancel", agentId: a.id });
    picking = null;
  } else if (what === "ask-uninstall") {
    menuFor = null;
    confirming = `agent:${a.id}`;
  } else if (what === "confirm-cancel") confirming = null;
  else if (what === "uninstall") {
    confirming = null;
    post({ type: "agent_remove", id: a.id });
  }
  rerender();
});
$("agents").addEventListener("submit", (e) => {
  if (!e.target.matches(".code-form")) return;
  e.preventDefault();
  const id = e.target.closest("[data-agent]").dataset.agent;
  const input = e.target.elements.text;
  if (!input.value.trim()) return;
  post({ type: "auth_input", agentId: id, text: input.value.trim() });
  input.value = "";
});
document.addEventListener("click", (e) => {
  if (menuFor && !e.target.closest(".menu")) {
    menuFor = null;
    rerender();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (menuFor || confirming) {
    menuFor = confirming = null;
    rerender();
  }
});

/** Authentication command output, with URLs as links. */
function setOutput(pre, text) {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 20;
  pre.innerHTML = esc(text.trim() || "Starting…").replace(
    /https?:\/\/[^\s<>"']+/g,
    (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>`,
  );
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ---------- installing ----------

const fmtMB = (n) => `${Math.round(n / 1e6)} MB`;

function renderAddStatus(s) {
  const agents = s.agents;
  const parts = [];
  const ins = agents?.installing;
  if (s.connected && ins && !ins.update) {
    const pct = ins.total ? (100 * ins.received) / ins.total : null;
    const what = {
      downloading: `Downloading ${esc(ins.name)}${ins.received ? ` (${fmtMB(ins.received)}${ins.total ? ` of ${fmtMB(ins.total)}` : ""})` : ""}…`,
      verifying: `Checking the download…`,
      extracting: `Unpacking ${esc(ins.name)}…`,
      npm: `Installing ${esc(ins.name)}…`,
      waiting: `Waiting for another install to finish…`,
      checking: `Installing ${esc(ins.name)}…`,
    }[ins.phase] ?? `Installing ${esc(ins.name)}…`;
    parts.push(
      `<div class="row agent">${tile(agents.list.find((a) => a.id === ins.id) ?? ins)}<div class="main"><span class="name">${esc(ins.name)}</span><span class="sub">${what}</span></div></div>` +
        `<div class="install-status"><div class="progress"><span style="width: ${pct == null || ins.phase !== "downloading" ? 100 : pct.toFixed(1)}%"></span></div></div>`,
    );
  }
  if (s.connected && agents?.installError) {
    const a = agents.list.find((x) => x.id === agents.installError.id) ?? { id: agents.installError.id, name: agents.installError.id };
    parts.push(
      `<div class="row agent">${tile(a)}<div class="main"><span class="name">${esc(a.name)}</span><span class="sub danger">Couldn’t install: ${esc(agents.installError.message)}</span></div>` +
        `<div class="actions"><button type="button" class="btn primary" data-install="${esc(a.id)}">Try again</button></div></div>`,
    );
  }
  const adding = agents?.adding;
  if (s.connected && adding) {
    const name = adding.command.trim().split(/\s+/)[0]?.split(/[\\/]/).pop() || "agent";
    parts.push(
      adding.busy
        ? `<div class="row agent">${tile({ name })}<div class="main"><span class="name">${esc(name)}</span><span class="sub">Checking ${esc(name)}…</span></div></div>` +
            `<div class="install-status"><div class="progress"><span style="width: 100%"></span></div></div>`
        : `<div class="row agent">${tile({ name })}<div class="main"><span class="name">${esc(name)}</span><span class="sub danger">Couldn’t add: ${esc(adding.error)}</span></div>` +
            `<div class="actions"><button type="button" class="btn primary" data-do="local-retry">Try again</button>` +
            `<button type="button" class="icon-btn lg" data-do="local-dismiss" aria-label="Dismiss" title="Dismiss">${icon("x")}</button></div></div>`,
    );
  }
  if (s.connected && agents?.registryError) {
    parts.push(`<div class="install-status"><span class="error-text">${esc(agents.registryError)}</span><div><button type="button" class="btn" data-do="refresh">Try again</button></div></div>`);
  }
  const html = parts.join("");
  if ($("add-status").dataset.html !== html) $("add-status").innerHTML = $("add-status").dataset.html = html;
}
$("add-status").addEventListener("click", (e) => {
  const id = e.target.closest("[data-install]")?.dataset.install;
  if (id) post({ type: "agent_install", id });
  if (e.target.closest("[data-do=refresh]")) post({ type: "agents_refresh" });
  if (e.target.closest("[data-do=local-dismiss]")) post({ type: "agent_add_local_clear" });
  if (e.target.closest("[data-do=local-retry]")) {
    const command = state.agents.adding?.command ?? "";
    post({ type: "agent_add_local_clear" });
    openAddDialog(command);
  }
});

// ---------- add an agent ----------

$("add-btn").addEventListener("click", () => openAddDialog());
$("add-close").addEventListener("click", () => $("add-dialog").close());
$("add-filter").addEventListener("input", renderAddDialog);
$("add-dialog").addEventListener("click", (e) => e.target === $("add-dialog") && $("add-dialog").close());

let commandOpen = false; // the "Use a command" form is showing

function openAddDialog(command = "") {
  $("add-filter").value = "";
  commandOpen = Boolean(command);
  $("add-dialog").showModal();
  renderAddDialog();
  if (command) {
    $("local-command").value = command;
    $("local-command").focus();
  } else $("add-filter").focus();
}

function renderAddDialog() {
  if (!$("add-dialog").open || !state?.agents) return;
  const q = $("add-filter").value.trim().toLowerCase();
  // Agents that can't be installed on this computer aren't worth listing.
  const list = state.agents.list
    .filter((a) => !a.unavailable && (!q || a.name.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  // Agents installed by hand that Agent Bridge found: run as they are.
  const found = (state.agents.found ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
  const managed = list.filter((a) => a.kind !== "local");
  const options = managed
    .map((a) =>
      a.installedVersion
        ? `<button type="button" class="option" role="listitem" disabled>${tile(a)}<span class="main"><span class="name">${esc(a.name)}</span></span><span class="installed">${icon("check", { size: 14 })}Installed</span></button>`
        : `<button type="button" class="option" role="listitem" data-add="${esc(a.id)}">${tile(a)}<span class="main"><span class="name">${esc(a.name)}</span></span></button>`,
    )
    .join("");
  const foundHtml = found.length
    ? `<p class="menu-label">On this computer</p>` +
      found
        .map(
          (f) =>
            `<button type="button" class="option" role="listitem" data-local="${esc(f.command)}" data-registry="${esc(f.registryId)}">${tile(f)}<span class="main"><span class="name">${esc(f.name)}</span><span class="sub mono">${esc(f.command)}</span></span></button>`,
        )
        .join("") +
      (options ? `<p class="menu-label">Install</p>` : "")
    : "";
  const command = commandOpen
    ? `<form id="local-form" class="local-form"><input id="local-command" class="field mono" name="command" autocomplete="off" spellcheck="false" placeholder="gemini --acp" aria-label="Command that starts the agent" />` +
      `<button type="submit" class="send" aria-label="Add">${icon("arrow-up", { stroke: 2.25 })}</button></form>`
    : `<button type="button" class="option" role="listitem" data-do="command"><span class="tile">${icon("square-terminal", { size: 16 })}</span><span class="main"><span class="name">Use a command</span></span></button>`;
  const html = foundHtml + (options || (found.length ? "" : `<p class="muted" style="padding: 8px 14px">No agents match.</p>`)) + command;
  // Rebuild only on change, so a command being typed keeps its focus.
  if ($("add-list").dataset.html !== html) $("add-list").innerHTML = $("add-list").dataset.html = html;
}
$("add-list").addEventListener("click", (e) => {
  if (e.target.closest("[data-do=command]")) {
    commandOpen = true;
    renderAddDialog();
    return $("local-command").focus();
  }
  const local = e.target.closest("[data-local]");
  if (local) {
    post({ type: "agent_add_local", command: local.dataset.local, registryId: local.dataset.registry });
    return $("add-dialog").close();
  }
  const id = e.target.closest("[data-add]")?.dataset.add;
  if (!id) return;
  post({ type: "agent_install", id });
  $("add-dialog").close();
});
$("add-list").addEventListener("submit", (e) => {
  e.preventDefault();
  const command = $("local-command").value.trim();
  if (!command) return;
  post({ type: "agent_add_local", command });
  $("add-dialog").close();
});

// ---------- mods ----------

const NOT_RUNNING = "Not running";
const OTHER_MODS = "Other mods";

/** The sites a mod runs on (empty: every site), as Agent Bridge worked them out. */
const sitesOf = (mod) => mod.sites ?? [];

/** The group a mod is listed under: its one site, or "Other mods" for every site or several. */
function groupOf(mod) {
  const sites = sitesOf(mod);
  if (mod.error) return NOT_RUNNING;
  return sites.length === 1 ? sites[0] : OTHER_MODS;
}

/** For a mod in "Other mods": an icon that shows where it runs on hover or focus. */
function sitesIcon(sites) {
  const label = sites.length ? `Runs on ${sites.join(", ")}` : "Runs on every site";
  const list = sites.length ? sites.map((h) => `<span>${esc(h)}</span>`).join("") : `<span>Every site</span>`;
  return (
    `<span class="sites-icon" tabindex="0" role="img" aria-label="${esc(label)}">${icon("globe", { size: 14 })}` +
    `<span class="tip" aria-hidden="true"><span class="tip-label">Runs on</span>${list}</span></span>`
  );
}

/** "google.com, bing.com and 14 more". */
const siteList = (sites, n = 2) => sites.slice(0, n).join(", ") + (sites.length > n ? ` and ${sites.length - n} more` : "");

let modsKey = "";

// GM_download and GM_cookie need permissions Eyepatch asks for only when a
// mod uses them: the mod's row offers them (Chrome wants a click to ask).
const OPTIONAL = [
  { grant: "download", permission: "downloads", label: "Allow downloads" },
  { grant: "cookie", permission: "cookies", label: "Allow cookies" },
];
let permitted = new Set(DEMO ? [] : (chrome.runtime.getManifest().permissions ?? []));
async function readPermissions() {
  if (DEMO) return;
  permitted = new Set((await chrome.permissions.getAll()).permissions ?? []);
  if (state) rerender();
}
readPermissions();
if (!DEMO) {
  chrome.permissions.onAdded.addListener(readPermissions);
  chrome.permissions.onRemoved.addListener(readPermissions);
}
const missingPermissions = (mod) => (mod.error ? [] : OPTIONAL.filter((o) => mod.grants?.includes(o.grant) && !permitted.has(o.permission)));

function renderMods(s) {
  const mods = s.mods ?? [];
  $("mods-section").hidden = !s.connected && !mods.length;
  const arrived = Boolean(modFromLink && mods.some((m) => m.id === modFromLink));
  if (arrived) {
    currentMod = modFromLink;
    modFromLink = null;
    clearTimeout(modLinkTimer);
  }
  const key = JSON.stringify([mods, confirming, currentMod, [...permitted]]);
  if (key === modsKey) return arrived && showCurrentMod();
  modsKey = key;
  const bySite = new Map();
  for (const m of mods) {
    const group = groupOf(m);
    if (!bySite.has(group)) bySite.set(group, []);
    bySite.get(group).push(m);
  }
  // Broken mods first, then sites alphabetically, then other mods.
  const rank = (g) => (g === NOT_RUNNING ? 0 : g === OTHER_MODS ? 2 : 1);
  const sites = [...bySite.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  $("mods").innerHTML = sites
    .map((site) => {
      const broken = site === NOT_RUNNING;
      const title = broken ? `<h3 class="group-title danger">${icon("circle-alert", { size: 16 })}${site}</h3>` : `<h3 class="group-title">${icon("globe", { size: 16 })}${esc(site)}</h3>`;
      const rows = bySite
        .get(site)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) =>
          confirming === `mod:${m.id}`
            ? `<div class="confirm" data-mod="${esc(m.id)}"><div class="main"><span class="name">Delete “${esc(m.name)}”?</span><span class="sub">It stops running on ${sitesOf(m).length ? esc(siteList(sitesOf(m))) : "every site"}.</span></div>` +
              `<div class="actions"><button type="button" class="btn quiet" data-do="confirm-cancel">Cancel</button><button type="button" class="btn danger" data-do="delete">Delete</button></div></div>`
            : `<div class="row" data-mod="${esc(m.id)}"${m.id === currentMod ? ` aria-current="true" tabindex="-1"` : ""}><div class="main"><span class="name">${esc(m.name)}${site === OTHER_MODS ? sitesIcon(sitesOf(m)) : ""}</span>` +
              `<span class="sub${m.error ? " danger" : ""}" title="${esc([m.error ?? m.description, ...(m.warnings ?? []), m.id].filter(Boolean).join("\n"))}">${esc(m.error ?? m.description ?? m.id)}</span>` +
              `</div>` +
              missingPermissions(m).map((o) => `<button type="button" class="btn" data-do="permit" data-permission="${o.permission}">${o.label}</button>`).join("") +
              (m.error ? "" : `<button type="button" class="switch lg" role="switch" aria-checked="${m.enabled}" aria-label="${esc(m.name)}" data-do="toggle"></button>`) +
              `<button type="button" class="icon-btn lg" data-do="reveal" aria-label="Show ${esc(m.name)} in its folder" title="Show in folder">${icon("folder-open")}</button>` +
              `<button type="button" class="icon-btn lg" data-do="ask-delete" aria-label="Delete ${esc(m.name)}" title="Delete">${icon("trash-2")}</button></div>`,
        )
        .join("");
      return `<div class="mod-group">${title}<div class="group-items">${rows}</div></div>`;
    })
    .join("");
  if (arrived) showCurrentMod();
}

/** Bring the linked mod into view and focus; it's let go on the next click or key. */
function showCurrentMod() {
  const row = $("mods").querySelector(".row[aria-current]");
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.focus({ preventScroll: true });
  addEventListener("pointerdown", releaseCurrentMod, true);
  addEventListener("keydown", releaseCurrentMod, true);
}

function releaseCurrentMod() {
  removeEventListener("pointerdown", releaseCurrentMod, true);
  removeEventListener("keydown", releaseCurrentMod, true);
  currentMod = null;
  for (const r of $("mods").querySelectorAll(".row[aria-current]")) {
    r.removeAttribute("aria-current");
    r.removeAttribute("tabindex");
  }
  modsKey = "";
}

$("mods").addEventListener("click", (e) => {
  const what = e.target.closest("[data-do]")?.dataset.do;
  const id = e.target.closest("[data-mod]")?.dataset.mod;
  if (!what || !id) return;
  if (what === "toggle") {
    const sw = e.target.closest("[data-do=toggle]");
    const enabled = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(enabled));
    return post({ type: "mod_set_enabled", id, enabled });
  }
  if (what === "reveal") return post({ type: "mod_reveal", id });
  if (what === "permit") {
    const permission = e.target.closest("[data-permission]").dataset.permission;
    if (DEMO) return console.log("request", permission);
    // Must be called right in the click.
    return chrome.permissions.request({ permissions: [permission] }).then(readPermissions, (err) => showModsStatus([err.message]));
  }
  if (what === "ask-delete") confirming = `mod:${id}`;
  else if (what === "confirm-cancel") confirming = null;
  else if (what === "delete") {
    confirming = null;
    post({ type: "mod_delete", id });
  }
  rerender();
});

// ---------- import and export ----------
// Mods are userscripts (.user.js) and UserCSS styles (.user.css), the files
// Tampermonkey, Violentmonkey and Stylus use, so they move both ways as is.

/** Save a mod's file (exporting it). */
let importSeq = 0;
const importing = new Map(); // request id -> { name, done(result) }

function importMod(fileName, content, done) {
  const requestId = `i${++importSeq}`;
  importing.set(requestId, { name: fileName, done });
  post({ type: "mod_import", requestId, fileName, content });
}

function imported(msg) {
  const req = importing.get(msg.requestId);
  importing.delete(msg.requestId);
  req?.done(msg);
}

function showModsStatus(lines) {
  $("mods-status").innerHTML = lines.map((l) => `<span class="error-text">${esc(l)}</span>`).join("");
}

$("import-btn").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const errors = [];
  showModsStatus([]);
  for (const file of files) {
    importMod(file.name, await file.text(), (r) => {
      if (r.error) errors.push(`Couldn’t import ${file.name}: ${r.error}`);
      showModsStatus(errors);
    });
  }
});

// Opening a .user.js / .user.css URL brings you here (see interceptInstalls in
// background.js): options.html?install=<url>, the URL as it was, unencoded.
// Never inside a frame, where a site could trick you into installing.
const installUrl = window.top === window ? /[?&]install=(https?:\/\/.*)$/.exec(location.search)?.[1] : null;
$("install-close").addEventListener("click", () => $("install-dialog").close());

/** The header fields worth showing before installing (Agent Bridge does the real parsing). */
function previewOf(text) {
  const js = /==UserScript==([\s\S]*?)==\/UserScript==/.exec(text);
  const block = js ?? /==UserStyle==([\s\S]*?)==\/UserStyle==/.exec(text);
  if (!block) return null;
  const entries = [...block[1].matchAll(/^\s*(?:\/\/)?\s*@([\w:.-]+)(?:[ \t]+(.*?))?\s*$/gm)].map((m) => [m[1], m[2] ?? ""]);
  const get = (k) => entries.find((e) => e[0] === k)?.[1];
  const all = (k) => entries.filter((e) => e[0] === k).map((e) => e[1]);
  const sites = js
    ? [...all("match"), ...all("include")]
    : [...text.matchAll(/(?:domain|url-prefix|url|regexp)\(\s*["']?([^"')]*)/g)].map((m) => m[1]);
  return {
    name: get("name"),
    description: get("description"),
    version: get("version"),
    sites: [...new Set(sites)],
    grants: all("grant").flatMap((g) => g.split(/\s+/)).filter((g) => g && g !== "none"),
    connects: all("connect"),
  };
}

function renderInstall(html) {
  $("install-body").innerHTML = html;
}

async function offerInstall(url) {
  const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  $("install-dialog").showModal();
  renderInstall(`<p class="muted">Loading ${esc(fileName)}…</p>`);
  let text;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    return renderInstall(`<span class="error-text">Couldn’t load ${esc(url)}: ${esc(e.message)}</span>`);
  }
  const p = previewOf(text);
  if (!p) return renderInstall(`<span class="error-text">${esc(fileName)} isn’t a userscript or a UserCSS style.</span>`);
  const list = (xs, n = 6) => esc(xs.slice(0, n).join(", ")) + (xs.length > n ? ` and ${xs.length - n} more` : "");
  const rows = [
    p.version && ["Version", esc(p.version)],
    ["Runs on", p.sites.length ? list(p.sites) : "Every site"],
    p.grants.length && ["Uses", list(p.grants, 10)],
    p.connects.length && ["Can reach", list(p.connects)],
    ["From", esc(new URL(url).host)],
  ].filter(Boolean);
  const show = (error = "") =>
    renderInstall(
      `<div><div class="name">${esc(p.name || fileName)}</div>${p.description ? `<p class="muted">${esc(p.description)}</p>` : ""}</div>` +
        `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` +
        (error ? `<span class="error-text">${esc(error)}</span>` : "") +
        `<div class="actions"><button type="button" class="btn quiet" data-do="cancel">Cancel</button><button type="button" class="btn primary" data-do="install">Install</button></div>`,
    );
  show();
  $("install-body").onclick = (e) => {
    const what = e.target.closest("[data-do]")?.dataset.do;
    if (what === "cancel") $("install-dialog").close();
    if (what !== "install") return;
    if (!state?.connected) return show("Agent Bridge isn’t running.");
    e.target.disabled = true;
    importMod(fileName, text, (r) => {
      if (r.error) return show(r.error);
      $("install-dialog").close();
      history.replaceState(null, "", location.pathname);
      $("mods-section").scrollIntoView({ block: "start" });
    });
  };
}
if (installUrl) offerInstall(installUrl);

// Options page: setup checklist, installed agents (sign-in, remove), the
// agent catalog and every mod. Talks to the service worker, which relays to Agent Bridge.

import { fillIcons, icon } from "./icons.js";

fillIcons();
// Focus rings are for keyboard use; Chrome also shows them after some clicks.
addEventListener("pointerdown", () => document.body.classList.add("pointer"), true);
addEventListener("keydown", (e) => e.key === "Tab" && document.body.classList.remove("pointer"), true);

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CHECK = icon("check", { cls: "ok", label: "Done" });
const TRASH = icon("trash-2");

let state = null;
let port;
let picking = null; // agent id whose sign-in methods are showing
// From the side panel's "Sign in" button: options.html#signin=<agent id>
let signinFromLink = new URLSearchParams(location.hash.slice(1)).get("signin");

function connectPort() {
  port = chrome.runtime.connect({ name: "options" });
  port.onMessage.addListener((msg) => msg.type === "state" && render(msg.state));
  // The service worker was suspended or reloaded; reconnect.
  port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
}
connectPort();

const post = (msg) => port.postMessage(msg);

function render(s) {
  state = s;
  renderSetup(s);
  renderInstalled(s);
  renderAdd(s);
  renderMods(s);
}

// ---------- setup ----------

function renderSetup(s) {
  const installed = s.agents?.list.filter((a) => a.installedVersion) ?? [];
  const rows = [
    s.connected ? row("Agent Bridge is installed", CHECK) : row("Install Agent Bridge", ""),
    s.userScripts
      ? row("User scripts are allowed", CHECK)
      : row("Allow User Scripts", `<button type="button" data-action="open-settings">Open settings</button>`),
  ];
  if (s.connected && s.agents && !s.agents.custom) {
    rows.push(installed.length ? row("A coding agent is installed", CHECK) : row("Install a coding agent", ""));
  }
  $("setup").innerHTML = rows.join("");
}

const row = (text, end) => `<li class="row"><span class="grow">${text}</span>${end}</li>`;

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-action=open-settings]")) chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

// ---------- installed agents ----------

const rowKeys = new Map(); // agent id -> what its row was last built from

function renderInstalled(s) {
  const el = $("installed");
  const agents = s.agents;
  $("agents-section").hidden = !s.connected || !agents;
  if (!s.connected || !agents) return;

  const installed = agents.custom
    ? [{ id: "custom", name: s.auths.custom?.agent ?? "Custom agent", icon: null, custom: true }]
    : agents.list.filter((a) => a.installedVersion);
  if (!installed.length) {
    el.innerHTML = "";
    rowKeys.clear();
    return;
  }

  // Rebuild only rows whose content changed, so a code being typed isn't lost.
  const ids = installed.map((a) => a.id);
  if ([...el.children].map((li) => li.dataset.agent).join() !== ids.join()) {
    el.innerHTML = ids.map((id) => `<li class="agent" data-agent="${esc(id)}"></li>`).join("");
    rowKeys.clear();
  }
  for (const a of installed) {
    const li = el.querySelector(`[data-agent="${CSS.escape(a.id)}"]`);
    const auth = s.auths[a.id];
    if (signinFromLink === a.id && auth) {
      signinFromLink = null;
      if (!auth.signIn && auth.methods.length > 1) picking = a.id;
      else if (!auth.signIn && auth.methods.length === 1) post({ type: "auth_start", agentId: a.id, methodId: auth.methods[0].id });
      requestAnimationFrame(() => li.scrollIntoView({ block: "center" }));
    }
    const key = JSON.stringify([a, agents.installing?.id === a.id, auth && { ...auth, signIn: auth.signIn && { ...auth.signIn, output: null } }, picking === a.id]);
    if (rowKeys.get(a.id) === key) {
      const out = li.querySelector(".output");
      if (out && auth?.signIn) setOutput(out, auth.signIn.output);
      continue;
    }
    rowKeys.set(a.id, key);
    li.innerHTML = agentRow(a, auth, agents);
    wireAgentRow(li, a, auth);
  }
}

function agentRow(a, auth, agents) {
  const logo = a.icon ? `<img src="${esc(a.icon)}" alt="" />` : `<span class="noicon"></span>`;
  // Whatever the agent reports about the account, as it reports it.
  const account = (auth?.accounts ?? [])
    .map((x) => [x.label, x.email && x.email !== x.label ? x.email : null, x.organization].filter(Boolean).join(" · "))
    .join(", ");
  const signedOut = auth?.state === "unauthenticated";
  const updating = agents.installing?.update && agents.installing.id === a.id;
  const status = signedOut ? `<span class="warn">Not signed in</span>` : account ? esc(account) : "";
  const busySigningIn = Boolean(auth?.signIn);
  const showMethods = Boolean(auth && !busySigningIn && (picking === a.id || (signedOut && auth.methods.length > 1)));
  const canSignIn = auth && auth.methods.length && !busySigningIn && !showMethods;

  const head = `<div class="row">
    ${logo}
    <span class="grow"><strong>${esc(a.name)}</strong>${status ? `<span class="sub">${status}</span>` : ""}</span>
    ${updating ? `<span class="muted small">Updating…</span>` : ""}
    ${canSignIn ? `<button type="button" data-do="signin">${auth.error ? "Try again" : signedOut ? "Sign in" : "Sign in again"}</button>` : ""}
    ${a.custom ? "" : `<button type="button" class="icon" data-do="remove" aria-label="Remove ${esc(a.name)}" title="Remove" ${agents.installing?.id === a.id ? "disabled" : ""}>${TRASH}</button>`}
  </div>`;

  const body = [];
  if (busySigningIn) {
    const terminal = auth.methods.find((m) => m.id === auth.signIn.methodId)?.kind === "terminal";
    body.push(`<p>Signing in with ${esc(auth.signIn.name)}…</p>`);
    if (terminal) {
      body.push(
        `<pre class="output"></pre>`,
        `<form class="code"><input name="text" autocomplete="off" placeholder="Paste code" aria-label="Paste code" /><button type="submit">Submit</button></form>`,
      );
    }
    body.push(`<div><button type="button" data-do="cancel">Cancel</button></div>`);
  } else if (showMethods) {
    body.push(
      `<div class="methods">${auth.methods
        .map((m) => `<button type="button" class="method" data-method="${esc(m.id)}"><strong>${esc(m.name)}</strong>${m.description ? `<small>${esc(m.description)}</small>` : ""}</button>`)
        .join("")}</div>`,
    );
    if (picking === a.id && !signedOut) body.push(`<div><button type="button" data-do="unpick">Cancel</button></div>`);
  }
  if (auth?.error) body.push(`<p class="error">${esc(auth.error)}</p>`);
  return head + (body.length ? `<div class="detail">${body.join("")}</div>` : "");
}

function wireAgentRow(li, a, auth) {
  const out = li.querySelector(".output");
  if (out) setOutput(out, auth.signIn.output);
  li.querySelector("[data-do=signin]")?.addEventListener("click", () => {
    if (auth.methods.length === 1) post({ type: "auth_start", agentId: a.id, methodId: auth.methods[0].id });
    else {
      picking = a.id;
      render(state);
    }
  });
  li.querySelector("[data-do=unpick]")?.addEventListener("click", () => {
    picking = null;
    render(state);
  });
  li.querySelectorAll("[data-method]").forEach((b) =>
    b.addEventListener("click", () => {
      picking = null;
      post({ type: "auth_start", agentId: a.id, methodId: b.dataset.method });
    }),
  );
  li.querySelector("[data-do=cancel]")?.addEventListener("click", () => post({ type: "auth_cancel", agentId: a.id }));
  li.querySelector("[data-do=remove]")?.addEventListener("click", () => {
    if (confirm(`Remove ${a.name}? Tabs using it start a new chat with another agent.`)) post({ type: "agent_remove", id: a.id });
  });
  li.querySelector("form.code")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    if (!input.value.trim()) return;
    post({ type: "auth_input", agentId: a.id, text: input.value.trim() });
    input.value = "";
  });
  li.querySelector("form.code input")?.focus();
}

/** Sign-in command output, with URLs as links. */
function setOutput(pre, text) {
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 20;
  pre.innerHTML = esc(text.trim() || "Starting…").replace(
    /https?:\/\/[^\s<>"']+/g,
    (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>`,
  );
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ---------- adding agents ----------

const fmtMB = (n) => `${Math.round(n / 1e6)} MB`;
let addOpen = false;

function setAddMenu(open) {
  addOpen = open;
  renderAdd(state);
}
$("add-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  setAddMenu(!addOpen);
});
document.addEventListener("click", (e) => addOpen && !e.target.closest("#add-menu") && setAddMenu(false));
document.addEventListener("keydown", (e) => e.key === "Escape" && addOpen && setAddMenu(false));

function renderAdd(s) {
  const agents = s.agents;
  $("add").hidden = !s.connected || !agents || Boolean(agents.custom);
  $("add-status").hidden = $("add").hidden;
  if ($("add").hidden) return;

  const status = [];
  const ins = agents.installing;
  if (ins && !ins.update) {
    const pct = ins.total ? Math.round((100 * ins.received) / ins.total) : null;
    const what = {
      downloading: `Downloading ${esc(ins.name)}${ins.received ? ` (${fmtMB(ins.received)}${ins.total ? ` of ${fmtMB(ins.total)}` : ""})` : ""}…`,
      verifying: `Checking the download…`,
      extracting: `Unpacking…`,
      npm: `Installing ${esc(ins.name)}…`,
      checking: `Installing ${esc(ins.name)}…`,
    }[ins.phase];
    status.push(`<p>${what}</p><progress ${pct != null && ins.phase === "downloading" ? `value="${pct}" max="100"` : ""}></progress>`);
  }
  if (agents.installError) {
    const name = agents.list.find((a) => a.id === agents.installError.id)?.name ?? agents.installError.id;
    status.push(`<p class="error">Couldn't install ${esc(name)}: ${esc(agents.installError.message)}</p>`);
  }
  if (agents.registryError) {
    status.push(`<p class="error">${esc(agents.registryError)}</p><div><button type="button" id="retry">Try again</button></div>`);
  }
  $("add-status").innerHTML = status.join("");
  $("retry")?.addEventListener("click", () => post({ type: "agents_refresh" }));

  // Agents that can't be installed on this computer aren't worth listing.
  const available = agents.list.filter((a) => !a.installedVersion && !a.unavailable);
  const installing = Boolean(ins && !ins.update);
  $("add-btn").disabled = installing || !available.length;
  const open = addOpen && !$("add-btn").disabled;
  $("add-menu").hidden = !open;
  $("add-btn").setAttribute("aria-expanded", String(open));
  if (!open) return;

  const item = (a) => {
    const logo = a.icon ? `<img src="${esc(a.icon)}" alt="" />` : `<span class="noicon"></span>`;
    return `<button type="button" role="menuitem" data-install="${esc(a.id)}">${logo}<span>${esc(a.name)}</span></button>`;
  };
  const sorted = [...available].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  $("add-menu").innerHTML = sorted.map(item).join("");
  $("add-menu").querySelectorAll("[data-install]").forEach((b) =>
    b.addEventListener("click", () => {
      addOpen = false;
      post({ type: "agent_install", id: b.dataset.install });
      renderAdd(state);
    }),
  );
}

// ---------- mods ----------

/** The site a mod is for, from its first match pattern. */
function siteOf(mod) {
  const host = /^[^:]+:\/\/([^/]*)/.exec(mod.matches[0] ?? "")?.[1] ?? "";
  const site = host.replace(/^\*\./, "").replace(/^www\./, "");
  return !site || site === "*" ? "All sites" : site;
}

let modsKey = "";

function renderMods(s) {
  const mods = s.mods ?? [];
  $("mods-section").hidden = !mods.length;
  const key = JSON.stringify(mods);
  if (key === modsKey) return;
  modsKey = key;
  const bySite = new Map();
  for (const m of mods) {
    const site = m.error ? "Not running" : siteOf(m);
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(m);
  }
  const sites = [...bySite.keys()].sort((a, b) => (a === "Not running") - (b === "Not running") || a.localeCompare(b));
  $("mods").innerHTML = sites
    .map(
      (site) =>
        `<h3>${esc(site)}</h3><ul class="rows">${bySite
          .get(site)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (m) => `<li class="row" data-mod="${esc(m.id)}">
              <span class="grow"><strong>${esc(m.name)}</strong><span class="sub ${m.error ? "error" : ""}" title="${esc(m.error ?? m.description ?? "")}">${esc(m.error ?? m.description ?? m.id)}</span></span>
              ${m.error ? "" : `<input type="checkbox" class="switch" data-do="toggle" ${m.enabled ? "checked" : ""} aria-label="${esc(m.name)}" />`}
              <button type="button" class="icon" data-do="delete" aria-label="Delete ${esc(m.name)}" title="Delete">${TRASH}</button>
            </li>`,
          )
          .join("")}</ul>`,
    )
    .join("");
}

$("mods").addEventListener("change", (e) => {
  const id = e.target.closest("[data-mod]")?.dataset.mod;
  if (id && e.target.dataset.do === "toggle") post({ type: "mod_set_enabled", id, enabled: e.target.checked });
});
$("mods").addEventListener("click", (e) => {
  if (!e.target.closest("[data-do=delete]")) return;
  const id = e.target.closest("[data-mod]").dataset.mod;
  const mod = state.mods.find((m) => m.id === id);
  if (confirm(`Delete ${mod?.name ?? id}?`)) post({ type: "mod_delete", id });
});

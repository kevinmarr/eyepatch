// site-modder service worker: owns the WebSocket to Agent Bridge (the local
// program that runs the agent),
// runs browser tools for the agent, registers mods as user scripts, and
// relays chat between Agent Bridge and any open side panels.

const BRIDGE_PORT = 7457;
const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const PROBE_URL = `http://127.0.0.1:${BRIDGE_PORT}/`;
const MAX_TRANSCRIPT = 2000;
const MAX_SCREENSHOT_EDGE = 1568; // larger images get downscaled by the model API anyway

let ws = null;
let bridge = { connected: false, agent: null, ready: false, busy: false };
let auth = null; // agent sign-in state, from Agent Bridge
let agents = null; // agent catalog, selection and install progress, from Agent Bridge
let transcript = []; // chat events, replayed to side panels when they open
let windowId = null; // window of the panel that sent the last prompt
let targetTabId = null; // tab the last prompt was sent from
let targetUrl = null; // that tab's URL when the prompt was sent
const tabRequests = new Map(); // id -> resolve(accepted: boolean), for "switch to tab" cards
let tabRequestSeq = 0;
let modErrors = {}; // mod id -> registration error
let lastMods = new Map(); // mod id -> mod, to tell CSS-only changes apart
const panels = new Set();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------- bridge connection ----------

let probing = false;

async function connect() {
  if (probing) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // Chrome logs every refused WebSocket as an extension error, so check with a
  // plain fetch first and only open the socket once something is listening.
  // (Agent Bridge answers non-upgrade HTTP requests with 426; any response is fine.)
  probing = true;
  try {
    await fetch(PROBE_URL, { cache: "no-store" });
  } catch {
    // Agent Bridge not running. Retry fast while a panel is open; otherwise the alarm retries.
    if (panels.size) setTimeout(connect, 2000);
    return;
  } finally {
    probing = false;
  }
  if (ws) return;
  const socket = new WebSocket(BRIDGE_URL);
  ws = socket;
  socket.onopen = () => {
    bridge = { ...bridge, connected: true };
    send({ type: "hello", extensionVersion: chrome.runtime.getManifest().version });
    broadcastState();
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    declineTabRequests("Agent Bridge disconnected");
    bridge = { connected: false, agent: null, ready: false, busy: false };
    auth = null;
    agents = null;
    broadcastState();
    setTimeout(connect, 2000);
  };
  socket.onerror = () => {};
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onBridgeMessage(msg).catch((e) => console.error("[site-modder]", e));
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Service workers get suspended; an alarm brings us back to reconnect.
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "reconnect" && connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

async function onBridgeMessage(msg) {
  switch (msg.type) {
    case "ping":
      return;
    case "status":
      bridge = { ...bridge, ...msg, connected: true };
      updateBadge();
      return broadcastState();
    case "session_update":
    case "turn_end":
    case "error":
    case "permission_request":
    case "permission_resolved":
      return record(msg);
    case "tool_call":
      return runTool(msg);
    case "auth":
      auth = msg.auth;
      return broadcastState();
    case "agents":
      agents = msg.agents;
      return broadcastState();
    case "agent_changed":
      // A different agent doesn't share the old one's conversation.
      return clearTranscript();
    case "reload_extension":
      return chrome.runtime.reload();
  }
}

// ---------- side panels ----------

function record(event) {
  transcript.push(event);
  if (transcript.length > MAX_TRANSCRIPT) transcript = transcript.slice(-MAX_TRANSCRIPT);
  for (const p of panels) p.postMessage({ type: "event", event });
  attend(event).catch((e) => console.error("[site-modder] attention:", e));
}

function state() {
  return { bridge, auth, agents, userScripts: userScriptsAvailable(), modErrors };
}

function clearTranscript() {
  transcript = [];
  for (const p of panels) p.postMessage({ type: "init", state: state(), transcript });
}

function broadcastState() {
  for (const p of panels) p.postMessage({ type: "state", state: state() });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  panels.add(port);
  connect();
  port.postMessage({ type: "init", state: state(), transcript });
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    panelVisible.delete(port);
  });
  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case "prompt": {
        windowId = msg.windowId ?? windowId;
        const tab = await activeTab().catch(() => null);
        // Pin the agent's tools to this tab for the turn, even if the user
        // switches tabs while it works.
        targetTabId = tab?.id ?? null;
        targetUrl = tab?.url ?? null;
        record({ type: "user_message", text: msg.text, url: tab?.url });
        send({ type: "prompt", text: msg.text, page: tab && { tabId: tab.id, url: tab.url, title: tab.title } });
        break;
      }
      case "cancel":
        declineTabRequests("the user stopped the agent");
        send({ type: "cancel" });
        break;
      case "auth_start":
      case "auth_input":
      case "auth_cancel":
      case "auth_logout":
      case "auth_recheck":
      case "agent_select":
      case "agents_refresh":
        send(msg);
        break;
      case "tab_response":
        tabRequests.get(msg.id)?.(msg.accept ? { accepted: true } : { accepted: false, reason: "the user chose Not now" });
        break;
      case "new_session":
        send({ type: "new_session" });
        clearTranscript();
        break;
      case "permission_response":
        send({ type: "permission_response", id: msg.id, optionId: msg.optionId });
        break;
      case "set_window":
        windowId = msg.windowId;
        break;
      case "visibility":
        panelVisible.set(port, msg.visible);
        if (msg.visible) {
          unseenTurnEnd = false;
          updateBadge();
        }
        break;
    }
  });
});

// ---------- browser tools (called by the agent) ----------

async function activeTab() {
  const query = windowId != null ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
  const [tab] = await chrome.tabs.query(query);
  if (!tab) throw new Error("No active tab");
  return tab;
}

/** The tab the user's latest message was sent from; browser tools act on it. */
async function targetTab() {
  if (targetTabId == null) return activeTab();
  try {
    return await chrome.tabs.get(targetTabId);
  } catch {
    throw new Error("The tab this conversation was working on has been closed. Ask the user to send a message from the tab they want changed.");
  }
}

const BACKGROUND_TAB_HELP =
  "Chrome can only screenshot the tab the user is looking at, and they're on another tab. get_page_content, query_selector_all, run_js and get_console_logs still work on this tab; use them to verify instead.";

/**
 * Ask the user (via a card in the side panel, plus a notification if they're
 * not watching it) to switch back to `tab` so it can be screenshotted. There's
 * deliberately no timeout: the agent waits until the user acts. Resolves
 * { ok: true } once the tab is visible: they clicked "Switch to tab" or
 * switched to it themselves. Otherwise { ok: false, reason }.
 */
function requestTabSwitch(tab) {
  const id = `t${++tabRequestSeq}`;
  return new Promise((resolve) => {
    // byUser: they activated the tab themselves, so there's nothing to switch.
    const finish = async ({ accepted, reason, byUser = false }) => {
      if (!tabRequests.has(id)) return;
      tabRequests.delete(id);
      chrome.tabs.onActivated.removeListener(onActivated);
      if (accepted) {
        try {
          if (!byUser) {
            await chrome.tabs.update(tab.id, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          await new Promise((r) => setTimeout(r, 400)); // let it paint
        } catch (e) {
          // Only a failure if the tab didn't end up in front anyway.
          const now = await chrome.tabs.get(tab.id).catch(() => null);
          if (!now?.active) {
            accepted = false;
            reason = `switching to the tab failed: ${e?.message ?? e}`;
          }
        }
      }
      console.log(`[site-modder] tab request ${id}:`, accepted ? "switched" : reason);
      record({ type: "tab_request_resolved", id, accepted, reason });
      resolve(accepted ? { ok: true } : { ok: false, reason });
    };
    const onActivated = (info) => info.tabId === tab.id && finish({ accepted: true, byUser: true });
    chrome.tabs.onActivated.addListener(onActivated);
    tabRequests.set(id, finish);
    record({ type: "tab_request", id, tabId: tab.id, title: tab.title, url: tab.url, purpose: "take a screenshot" });
  });
}

/** Resolve every open tab request as declined (agent stopped, Agent Bridge gone). */
function declineTabRequests(reason) {
  for (const finish of [...tabRequests.values()]) finish({ accepted: false, reason });
}

/** Origin + path, ignoring query and hash (tracking params, in-page anchors). */
function pageKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url ?? "";
  }
}

/** A note for the agent if the pinned tab has navigated since the user's message. */
async function navigationWarning() {
  if (targetTabId == null || !targetUrl) return undefined;
  const tab = await chrome.tabs.get(targetTabId).catch(() => null);
  if (!tab?.url || pageKey(tab.url) === pageKey(targetUrl)) return undefined;
  return `Note: the user navigated this tab from ${targetUrl} to ${tab.url} since their message; this result is from the new page.`;
}

function userScriptsAvailable() {
  try {
    chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

// Chrome has no event for the "Allow User Scripts" toggle, so check while a
// side panel is open (that's where the banner asking for it is shown).
let userScriptsOn = userScriptsAvailable();
function checkUserScripts() {
  const on = userScriptsAvailable();
  if (on === userScriptsOn) return;
  userScriptsOn = on;
  broadcastState();
  // Just turned on: have Agent Bridge send the mods again so they get registered.
  if (on) send({ type: "sync_mods" });
}
setInterval(() => panels.size && checkUserScripts(), 1000);

const USER_SCRIPTS_HELP =
  'User scripts are disabled. Open chrome://extensions, click "Details" on site-modder and turn on "Allow User Scripts".';

async function inPage(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const tools = {
  async get_tab() {
    const tab = await targetTab();
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      status: tab.status,
      urlAtMessage: targetUrl,
      navigatedSinceMessage: targetUrl != null && pageKey(tab.url) !== pageKey(targetUrl),
      userIsViewingIt: tab.active,
    };
  },

  async get_page_content({ selector, format = "html", maxChars = 30000 }) {
    const tab = await targetTab();
    return inPage(
      tab.id,
      (selector, format, maxChars) => {
        const el = selector ? document.querySelector(selector) : document.body;
        if (!el) return { error: `No element matches ${selector}` };
        let content;
        if (format === "text") {
          content = el.innerText;
        } else {
          const clone = el.cloneNode(true);
          clone.querySelectorAll("script, style, noscript, link[rel=stylesheet]").forEach((n) => n.remove());
          clone.querySelectorAll("svg").forEach((n) => (n.innerHTML = ""));
          for (const n of [clone, ...clone.querySelectorAll("*")]) {
            for (const a of [...n.attributes]) {
              if (a.value.length > 200) n.setAttribute(a.name, a.value.slice(0, 200) + "…");
            }
          }
          content = clone.outerHTML;
        }
        return {
          length: content.length,
          truncated: content.length > maxChars,
          content: content.slice(0, maxChars),
        };
      },
      [selector ?? null, format, maxChars],
    );
  },

  async query_selector_all({ selector, limit = 20 }) {
    const tab = await targetTab();
    return inPage(
      tab.id,
      (selector, limit) => {
        const all = [...document.querySelectorAll(selector)];
        return {
          total: all.length,
          elements: all.slice(0, limit).map((el) => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              classes: [...el.classList],
              attributes: Object.fromEntries(
                [...el.attributes]
                  .filter((a) => a.name.startsWith("data-") || a.name.startsWith("aria-") || a.name === "role")
                  .map((a) => [a.name, a.value.slice(0, 100)]),
              ),
              text: (el.innerText ?? "").trim().slice(0, 150),
              visible: r.width > 0 && r.height > 0,
              html: el.outerHTML.slice(0, 300),
            };
          }),
        };
      },
      [selector, limit],
    );
  },

  async run_js({ code, world = "isolated" }) {
    if (!userScriptsAvailable()) throw new Error(USER_SCRIPTS_HELP);
    const tab = await targetTab();
    const [res] = await chrome.userScripts.execute({
      target: { tabId: tab.id },
      js: [{ code }],
      world: world === "main" ? "MAIN" : "USER_SCRIPT",
    });
    if (res?.error) throw new Error(res.error);
    return res?.result === undefined ? "undefined" : res.result;
  },

  async screenshot() {
    let tab = await targetTab();
    if (!tab.active) {
      const { ok, reason } = await requestTabSwitch(tab);
      if (!ok) throw new Error(`The user didn't switch back to the tab (${reason}). ${BACKGROUND_TAB_HELP}`);
      tab = await targetTab();
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    // Capture is in device pixels (2x on Retina). Scale to CSS pixels so image
    // coordinates match getBoundingClientRect, capped at the model's image size.
    const cssWidth = (await inPage(tab.id, () => window.innerWidth).catch(() => null)) ?? tab.width;
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const width = Math.min(bmp.width, cssWidth || bmp.width, MAX_SCREENSHOT_EDGE);
    const scale = width / bmp.width;
    const height = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bmp, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return {
      base64: await blobToBase64(blob),
      width,
      height,
      viewportWidth: cssWidth,
      cssPxPerImagePx: cssWidth ? cssWidth / width : null,
    };
  },

  async get_console_logs({ limit = 50, levels }) {
    if (!userScriptsAvailable()) throw new Error(USER_SCRIPTS_HELP);
    const tab = await targetTab();
    const read = `(() => { const b = globalThis.__smConsole; return b ? b.slice() : null; })()`;
    const entries = [];
    let installed = false;
    for (const world of ["USER_SCRIPT", "MAIN"]) {
      const [res] = await chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: read }], world });
      if (Array.isArray(res?.result)) entries.push(...res.result);
      else {
        await chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: captureCode(world) }], world, injectImmediately: true });
        installed = true;
      }
    }
    const wanted = levels?.length ? entries.filter((e) => levels.includes(e.level)) : entries;
    wanted.sort((a, b) => a.t - b.t);
    return {
      note: installed
        ? "Console capture was not active on this page and has been started now. Call reload_tab and then get_console_logs again to see messages from page load."
        : undefined,
      total: wanted.length,
      entries: wanted.slice(-limit).map((e) => ({ ...e, t: new Date(e.t).toISOString().slice(11, 23) })),
    };
  },

  async apply_mods({ mods, changed }) {
    await syncMods(mods, changed ?? []);
    return { errors: modErrors };
  },

  async reload_tab() {
    const tab = await targetTab();
    await reloadAndWait(tab.id);
    return "reloaded";
  },
};

async function runTool({ id, method, params }) {
  try {
    const fn = tools[method];
    if (!fn) throw new Error(`Unknown browser method ${method}`);
    const result = await fn(params ?? {});
    const warning = method === "apply_mods" ? undefined : await navigationWarning();
    send({ type: "tool_result", id, result, warning });
  } catch (e) {
    // Navigation often explains the failure (e.g. the tab is now on chrome://).
    const warning = method === "apply_mods" ? undefined : await navigationWarning().catch(() => undefined);
    send({ type: "tool_result", id, error: [warning, String(e?.message ?? e)].filter(Boolean).join("\n") });
  }
}

function reloadAndWait(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);
  });
}

// ---------- mods -> user scripts ----------

const styleId = (modId) => `site-modder-${modId}`;

function cssCode(modId, css) {
  return `(() => {
  const id = ${JSON.stringify(styleId(modId))};
  let s = document.getElementById(id);
  if (!s) {
    s = document.createElement("style");
    s.id = id;
    (document.head || document.documentElement).appendChild(s);
  }
  s.textContent = ${JSON.stringify(css)};
})();`;
}

function removeCssCode(modId) {
  return `document.getElementById(${JSON.stringify(styleId(modId))})?.remove();`;
}

/**
 * Console capture for one JS world. Each world (the page's MAIN world and the
 * USER_SCRIPT world mods run in) has its own globals and console, so this is
 * injected into both. Read back by get_console_logs.
 */
function captureCode(world) {
  return `(() => {
  if (globalThis.__smConsole) return;
  const buf = (globalThis.__smConsole = []);
  const fmt = (a) => {
    try {
      if (a instanceof Error) return a.stack || String(a);
      if (a && typeof a === "object") return JSON.stringify(a);
    } catch {}
    return String(a);
  };
  const push = (level, args) => {
    buf.push({ t: Date.now(), world: ${JSON.stringify(world === "MAIN" ? "page" : "mods")}, level, text: args.map(fmt).join(" ").slice(0, 2000) });
    if (buf.length > 300) buf.shift();
  };
  for (const level of ["error", "warn", "log", "info"]) {
    const orig = console[level];
    console[level] = function (...args) {
      push(level, args);
      return orig.apply(this, args);
    };
  }
  addEventListener("error", (e) => push("uncaught", [e.error || e.message]));
  addEventListener("unhandledrejection", (e) => push("unhandledrejection", [e.reason]));
})();`;
}

/** Records a mod's top-level exception (with the mod id) before rethrowing. */
function wrapModJs(mod) {
  return `try {
${mod.js}
} catch (e) {
  (globalThis.__smConsole ||= []).push({ t: Date.now(), world: "mods", level: "uncaught", text: ${JSON.stringify(`[mod ${mod.id}] `)} + (e?.stack || e) });
  throw e;
}`;
}

function scriptsFor(mod) {
  if (mod.error || !mod.enabled) return [];
  const common = { matches: mod.matches, excludeMatches: mod.excludeMatches ?? [] };
  const out = [];
  if (mod.css) {
    out.push({ ...common, id: `mod:${mod.id}:css`, js: [{ code: cssCode(mod.id, mod.css) }], runAt: "document_start", world: "USER_SCRIPT" });
  }
  if (mod.js) {
    out.push({ ...common, id: `mod:${mod.id}:js`, js: [{ code: wrapModJs(mod) }], runAt: mod.runAt, world: mod.world === "main" ? "MAIN" : "USER_SCRIPT" });
  }
  return out;
}

/** Capture console output from page load on every page a JS mod runs on. */
function captureScripts(mods) {
  const matches = [...new Set(mods.filter((m) => !m.error && m.enabled && m.js).flatMap((m) => m.matches))];
  if (!matches.length) return [];
  return ["USER_SCRIPT", "MAIN"].map((world) => ({
    id: `sm:capture:${world}`,
    matches,
    js: [{ code: captureCode(world) }],
    runAt: "document_start",
    world,
  }));
}

async function tabsMatching(mod) {
  try {
    return await chrome.tabs.query({ url: mod.matches });
  } catch {
    return [];
  }
}

async function syncMods(mods, changed) {
  if (!userScriptsAvailable()) {
    broadcastState();
    return;
  }
  const existing = await chrome.userScripts.getScripts();
  const ours = existing.filter((s) => s.id.startsWith("mod:") || s.id.startsWith("sm:")).map((s) => s.id);
  if (ours.length) await chrome.userScripts.unregister({ ids: ours });

  // Registered first so capture runs before any mod on the same page.
  try {
    const capture = captureScripts(mods);
    if (capture.length) await chrome.userScripts.register(capture);
  } catch (e) {
    console.warn("[site-modder] console capture not registered:", e);
  }

  modErrors = {};
  for (const mod of mods) {
    if (mod.error) {
      modErrors[mod.id] = mod.error;
      continue;
    }
    // Register per mod so one bad match pattern doesn't block the rest.
    const scripts = scriptsFor(mod);
    if (!scripts.length) continue;
    try {
      await chrome.userScripts.register(scripts);
    } catch (e) {
      modErrors[mod.id] = String(e?.message ?? e);
    }
  }

  // Apply changes to open tabs: CSS hot-swaps, anything else reloads.
  const next = new Map(mods.map((m) => [m.id, m]));
  const toReload = new Set();
  const hotSwaps = [];
  for (const id of changed) {
    const before = lastMods.get(id);
    const after = next.get(id);
    const live = (m) => m && !m.error && m.enabled;
    const cssOnly =
      live(before) && live(after) &&
      before.js === after.js && before.world === after.world && before.runAt === after.runAt &&
      JSON.stringify(before.matches) === JSON.stringify(after.matches);
    if (cssOnly) {
      for (const tab of await tabsMatching(after)) {
        const code = after.css ? cssCode(id, after.css) : removeCssCode(id);
        hotSwaps.push(chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code }] }).catch(() => {}));
      }
    } else {
      for (const m of [before, after]) if (m?.matches?.length) for (const t of await tabsMatching(m)) toReload.add(t.id);
    }
  }
  // Resolve only once changes are visible, so the agent's next tool call
  // (which Agent Bridge holds until this returns) sees the new page.
  await Promise.all([...hotSwaps, ...[...toReload].map((tabId) => reloadAndWait(tabId))]);
  lastMods = next;
  broadcastState();
  for (const [id, error] of Object.entries(modErrors)) {
    if (changed.includes(id)) record({ type: "error", message: `Mod "${id}": ${error}` });
  }
}

// ---------- attention: notifications + toolbar badge ----------
// The agent keeps working with the side panel closed. When it finishes or
// needs the user, and the user isn't watching the panel, notify them.

const panelVisible = new Map(); // port -> whether that panel is visible
const pendingPermissions = new Map(); // permission id -> options
let unseenTurnEnd = false;
let finalText = ""; // the agent's last run of text this turn, for the "done" notification
const notificationActions = new Map(); // notification id -> (buttonIndex | null) => void

async function userIsWatching() {
  if (![...panelVisible.values()].some(Boolean)) return false;
  const win = await chrome.windows.getLastFocused().catch(() => null);
  return Boolean(win?.focused);
}

async function notify(id, { title, message, buttons = [], sticky = false, onAction }) {
  if (await userIsWatching()) return;
  notificationActions.set(id, onAction ?? (() => focusConversation()));
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: message || " ",
    buttons: buttons.slice(0, 2).map((t) => ({ title: t })),
    requireInteraction: sticky,
    priority: sticky ? 2 : 0,
  });
}

function clearNotification(id) {
  notificationActions.delete(id);
  chrome.notifications.clear(id).catch(() => {});
}

/** Bring the conversation's tab forward and try to open the side panel. */
async function focusConversation() {
  const tab = await targetTab().catch(() => null);
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  // Only allowed with a user gesture; a notification click may or may not count.
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
}

chrome.notifications.onClicked.addListener((id) => {
  const action = notificationActions.get(id);
  clearNotification(id);
  action?.(null);
});
chrome.notifications.onButtonClicked.addListener((id, index) => {
  const action = notificationActions.get(id);
  clearNotification(id);
  action?.(index);
});
chrome.notifications.onClosed.addListener((id) => notificationActions.delete(id));

const clip = (s, n = 180) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

async function attend(event) {
  switch (event.type) {
    case "user_message":
      finalText = "";
      unseenTurnEnd = false;
      break;
    case "session_update": {
      const u = event.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") finalText += u.content.text;
      else if (u.sessionUpdate === "tool_call") finalText = "";
      return;
    }
    case "permission_request": {
      pendingPermissions.set(event.id, event.options);
      const allow = event.options.find((o) => o.kind === "allow_once");
      const reject = event.options.find((o) => o.kind === "reject_once");
      const choices = [allow, reject].filter(Boolean);
      await notify(`perm:${event.id}`, {
        title: "site-modder needs your permission",
        message: clip(event.toolCall?.title ?? "The agent wants to run a tool"),
        buttons: choices.map((o) => o.name),
        sticky: true,
        onAction: (index) => {
          if (index == null) return focusConversation();
          send({ type: "permission_response", id: event.id, optionId: choices[index].optionId });
        },
      });
      break;
    }
    case "permission_resolved":
      pendingPermissions.delete(event.id);
      clearNotification(`perm:${event.id}`);
      break;
    case "tab_request":
      await notify(`tab:${event.id}`, {
        title: "site-modder wants to see a tab",
        message: clip(`Switch back to “${event.title || event.url}” so the agent can ${event.purpose}.`),
        buttons: ["Switch to tab", "Not now"],
        sticky: true,
        onAction: (index) =>
          tabRequests.get(event.id)?.(
            index === 1 ? { accepted: false, reason: "the user chose Not now" } : { accepted: true },
          ),
      });
      break;
    case "tab_request_resolved":
      clearNotification(`tab:${event.id}`);
      break;
    case "turn_end": {
      if (event.stopReason === "cancelled") break; // the user stopped it; they know
      const watching = await userIsWatching();
      unseenTurnEnd = !watching;
      const failed = event.stopReason === "error" || event.stopReason === "refusal";
      await notify(`done:${Date.now()}`, {
        title: failed ? "site-modder stopped with an error" : "site-modder is done",
        message: clip(finalText) || (failed ? "Open the side panel for details." : "The agent finished its turn."),
      });
      break;
    }
    default:
      return;
  }
  updateBadge();
}

function updateBadge() {
  let text = "";
  let color = "#6e6e73";
  if (pendingPermissions.size || tabRequests.size) {
    text = "!";
    color = "#c2410c";
  } else if (bridge.busy) {
    text = "…";
  } else if (unseenTurnEnd) {
    text = "✓";
    color = "#15803d";
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

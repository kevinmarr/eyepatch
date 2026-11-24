// The extension's side of the userscript GM API (the page side is gmRuntime
// in userscripts.js). Each userscript runs in its own world and messages the
// service worker; each request names its mod, and is only served if that mod
// is running and @grants the function.

import { modApplies } from "./match.js";
import { worldIdOf } from "./userscripts.js";

/**
 * @param {object} opts
 * @param {(tabId?: number) => void} opts.onMenusChanged a tab's menu commands changed (or every tab's)
 * @param {(modId: string, values: object) => void} opts.onValuesChanged a mod's stored values changed (re-register it with them)
 */
export function createGmHost({ onMenusChanged, onValuesChanged }) {
  // ---------- the running mods ----------
  // What requests are checked against: each running mod's grants, @connect
  // hosts and pages, and a random token built into its registered code.
  // Chrome doesn't say which world a message comes from, so the token is
  // what proves it; only code in the mod's own world can read it.
  // Saved, because registered scripts keep running after the service worker
  // restarts, or while Agent Bridge isn't running.

  let mods = new Map(); // mod id -> { id, name, enabled, grants, connects, matches, excludeMatches, filter, token }
  const modsLoaded = chrome.storage.local
    .get("gmMods")
    .then(({ gmMods }) => {
      if (!mods.size) mods = new Map(Object.entries(gmMods ?? {}));
      onMenusChanged();
    })
    .catch(() => {});

  const randomToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

  /** Agent Bridge sent the mods (before they're registered). Returns each mod's token. */
  async function setMods(list) {
    await modsLoaded;
    const next = new Map();
    for (const m of list) {
      if (m.error || !m.enabled || m.kind !== "js") continue;
      const { id, name, enabled, grants, connects, matches, excludeMatches, filter } = m;
      next.set(id, { id, name, enabled, grants: grants ?? [], connects: connects ?? [], matches, excludeMatches, filter, token: mods.get(id)?.token ?? randomToken(), channel: mods.get(id)?.channel ?? randomToken() });
    }
    mods = next;
    await chrome.storage.local.set({ gmMods: Object.fromEntries(mods) }).catch(() => {});
    onMenusChanged();
    return (id) => mods.get(id)?.token;
  }

  const getMod = (id) => mods.get(id);
  /** The name of a mod's unsafeWindow bridge (see unsafe-window.js); kept with its token. */
  const channelFor = (id) => mods.get(id)?.channel;
  // ---------- storage ----------
  // Each mod's values live in chrome.storage.local under "gmv:<mod id>".

  const key = (modId) => `gmv:${modId}`;
  const writes = new Map(); // mod id -> promise of the last write, so writes apply in order

  async function readValues(modId) {
    return (await chrome.storage.local.get(key(modId)))[key(modId)] ?? {};
  }

  // New pages get the values with the script's registration, updated right
  // after each write (one update at a time per mod, the latest values last).
  const reregistering = new Map(); // mod id -> { running, again }
  async function valuesChanged(modId) {
    const r = reregistering.get(modId);
    if (r) return void (r.again = true);
    const state = { again: false };
    reregistering.set(modId, state);
    try {
      do {
        state.again = false;
        await onValuesChanged(modId, await readValues(modId));
      } while (state.again);
    } finally {
      reregistering.delete(modId);
    }
  }

  function update(modId, fn) {
    const next = (writes.get(modId) ?? Promise.resolve()).then(async () => {
      const values = await readValues(modId);
      fn(values);
      await chrome.storage.local.set({ [key(modId)]: values });
      void valuesChanged(modId);
    });
    writes.set(modId, next.catch(() => {}));
    return next;
  }

  // Other pages running the mod get changes too (coalesced, since some
  // scripts write on every scroll or keystroke).
  const pending = new Map(); // mod id -> Map(key -> { value, deleted })
  let flushTimer = null;
  function broadcast(modId, k, value, deleted, from) {
    if (!pending.has(modId)) pending.set(modId, new Map());
    pending.get(modId).set(k, { value, deleted, from });
    flushTimer ??= setTimeout(flush, 200);
  }
  async function flush() {
    flushTimer = null;
    await modsLoaded;
    const batch = [...pending];
    pending.clear();
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const [modId, changes] of batch) {
      const mod = getMod(modId);
      if (!mod) continue;
      const calls = [...changes].map(([k, c]) => `m.value(${JSON.stringify(k)}, ${JSON.stringify(c.value ?? null)}, ${c.deleted}, ${JSON.stringify(c.from ?? null)});`).join("\n");
      // Only reaches pages where the script is running (it set __eyepatchGM).
      const code = `(() => { const m = globalThis.__eyepatchGM; if (!m) return;\n${calls}\n})();`;
      for (const tab of tabs) {
        if (!tab.url || !modApplies(mod, tab.url)) continue;
        chrome.userScripts
          .execute({ target: { tabId: tab.id, allFrames: true }, js: [{ code }], world: "USER_SCRIPT", worldId: worldIdOf(modId) })
          .catch(() => {});
      }
    }
  }

  /** Forget a deleted mod's values. */
  function forget(modId) {
    chrome.storage.local.remove(key(modId)).catch(() => {});
  }

  // ---------- menu commands ----------
  // Shown in the side panel's menu under their mod. Kept in session storage
  // so they survive the service worker restarting.

  const menus = new Map(); // tab id -> [{ modId, id, caption, frameId, documentId }]
  const menusLoaded = chrome.storage.session
    .get("gmMenus")
    .then(({ gmMenus }) => {
      for (const [tabId, list] of Object.entries(gmMenus ?? {})) if (!menus.has(Number(tabId))) menus.set(Number(tabId), list);
    })
    .catch(() => {});
  function saveMenus(tabId) {
    chrome.storage.session.set({ gmMenus: Object.fromEntries(menus) }).catch(() => {});
    onMenusChanged(tabId);
  }

  function setMenu(tabId, entry, remove = false) {
    let list = menus.get(tabId) ?? [];
    // A new page in the tab: its old commands are gone.
    if (entry.frameId === 0) list = list.filter((c) => c.frameId !== 0 || c.documentId === entry.documentId);
    list = list.filter((c) => !(c.modId === entry.modId && c.id === entry.id && c.documentId === entry.documentId));
    if (!remove) list.push(entry);
    if (list.length) menus.set(tabId, list);
    else menus.delete(tabId);
    saveMenus(tabId);
  }

  /** The menu commands for a tab's side panel, of mods still running. */
  function menusFor(tabId) {
    return (menus.get(tabId) ?? []).filter((c) => getMod(c.modId)).map(({ modId, id, caption }) => ({ modId, id, caption }));
  }

  const loadStarts = new Map(); // tab id -> when its latest page started loading

  function navigationStarted(tabId) {
    loadStarts.set(tabId, Date.now());
  }

  /**
   * The tab finished loading and its top page is `documentId`: drop commands
   * from earlier pages (and from frames of earlier pages).
   */
  async function pruneMenus(tabId, documentId) {
    await menusLoaded;
    const list = menus.get(tabId);
    if (!list) return;
    const since = loadStarts.get(tabId) ?? 0;
    const next = list.filter((c) => (c.frameId === 0 ? c.documentId === documentId : c.at >= since));
    if (next.length === list.length) return;
    if (next.length) menus.set(tabId, next);
    else menus.delete(tabId);
    saveMenus(tabId);
  }

  function forgetTab(tabId) {
    void forgetTabObjects(tabId);
    loadStarts.delete(tabId);
    if (menus.delete(tabId)) saveMenus(tabId);
  }

  async function runMenu(tabId, modId, id) {
    await menusLoaded;
    const entry = (menus.get(tabId) ?? []).find((c) => c.modId === modId && c.id === id);
    if (!entry) return;
    const code = `globalThis.__eyepatchGM?.menu(${JSON.stringify(id)});`;
    await chrome.userScripts
      .execute({ target: { tabId, documentIds: [entry.documentId] }, js: [{ code }], world: "USER_SCRIPT", worldId: worldIdOf(modId) })
      .catch((e) => console.warn("[eyepatch] menu command:", e));
  }

  // ---------- notifications ----------
  // GM_notification's onclick and ondone run in the page that showed it.
  // Kept in session storage, since the service worker may restart while one
  // is showing.

  const notifications = new Map(); // notification id -> { modId, n, tabId, documentId, highlight, wants }
  let notificationSeq = 0;
  const notificationsLoaded = chrome.storage.session
    .get("gmNotifications")
    .then(({ gmNotifications }) => {
      for (const [id, v] of Object.entries(gmNotifications ?? {})) if (!notifications.has(id)) notifications.set(id, v);
    })
    .catch(() => {});
  const saveNotifications = () => chrome.storage.session.set({ gmNotifications: Object.fromEntries(notifications) }).catch(() => {});

  /** Tell the page its notification was clicked (`clicked`) or is gone. */
  async function callNotification(entry, event) {
    if (entry.tabId == null || !entry.wants[event]) return;
    const code = `globalThis.__eyepatchGM?.notified(${JSON.stringify(entry.n)}, ${JSON.stringify(event)});`;
    await chrome.userScripts
      .execute({ target: { tabId: entry.tabId, ...(entry.documentId ? { documentIds: [entry.documentId] } : {}) }, js: [{ code }], world: "USER_SCRIPT", worldId: worldIdOf(entry.modId) })
      .catch(() => {});
  }

  async function finishNotification(id, clear = true) {
    const entry = notifications.get(id);
    if (!entry) return;
    notifications.delete(id);
    saveNotifications();
    if (clear) await chrome.notifications.clear(id).catch(() => {});
    await callNotification(entry, "done");
  }

  chrome.notifications.onClicked.addListener(async (id) => {
    if (!id.startsWith("gm:")) return;
    await notificationsLoaded;
    const entry = notifications.get(id);
    if (!entry) return;
    if (entry.highlight && entry.tabId != null) {
      chrome.tabs
        .update(entry.tabId, { active: true })
        .then((tab) => chrome.windows.update(tab.windowId, { focused: true }))
        .catch(() => {});
    }
    await callNotification(entry, "click");
    await finishNotification(id);
  });
  chrome.notifications.onClosed.addListener(async (id) => {
    if (!id.startsWith("gm:")) return;
    await notificationsLoaded;
    await finishNotification(id, false);
  });

  // ---------- per-tab objects (GM_getTab / GM_saveTab) ----------
  // In session storage, as "gmt:<mod id>" -> { tab id: object }; gone when
  // the browser closes, and a tab's entry when the tab does.

  const tabsKey = (modId) => `gmt:${modId}`;
  const tabWrites = new Map(); // mod id -> promise of the last write
  /** A mod's tab objects, after any save still being written. */
  const readTabs = async (modId) => {
    await tabWrites.get(modId);
    return (await chrome.storage.session.get(tabsKey(modId)).catch(() => ({})))[tabsKey(modId)] ?? {};
  };
  function updateTabs(modId, fn) {
    const next = (tabWrites.get(modId) ?? Promise.resolve()).then(async () => {
      const tabs = (await chrome.storage.session.get(tabsKey(modId)))[tabsKey(modId)] ?? {};
      fn(tabs);
      await chrome.storage.session.set({ [tabsKey(modId)]: tabs });
    });
    tabWrites.set(modId, next.catch(() => {}));
    return next;
  }
  async function forgetTabObjects(tabId) {
    const all = await chrome.storage.session.get(null).catch(() => ({}));
    for (const k of Object.keys(all)) if (k.startsWith("gmt:") && String(tabId) in all[k]) await updateTabs(k.slice(4), (tabs) => delete tabs[tabId]);
  }

  // ---------- requests from pages ----------

  const STORAGE = ["getValue", "setValue", "deleteValue", "listValues", "getValues", "setValues", "deleteValues", "addValueChangeListener"];
  const NEEDS = {
    values: STORAGE,
    set: STORAGE,
    delete: STORAGE,
    openInTab: ["openInTab"],
    closeTab: ["openInTab"],
    notification: ["notification"],
    notificationRemove: ["notification"],
    getTab: ["getTab", "saveTab", "getTabs"],
    saveTab: ["saveTab"],
    getTabs: ["getTabs"],
    cookie: ["cookie"],
    menuRegister: ["registerMenuCommand"],
    menuUnregister: ["registerMenuCommand", "unregisterMenuCommand"],
  };
  const openedTabs = new Map(); // tab id -> mod id that opened it

  /** The mod a page's request is for, if it's running and grants `method`. */
  async function check(modId, token, method) {
    await modsLoaded;
    const mod = getMod(modId);
    if (!mod || mod.token !== token) throw new Error(`mod ${modId} isn't running`);
    if (!(NEEDS[method] ?? []).some((g) => mod.grants?.includes(g))) throw new Error(`${method} needs a @grant`);
    return mod;
  }

  async function handle({ mod: modId, token, method, args = [] }, sender) {
    const mod = await check(modId, token, method);
    const tabId = sender.tab?.id;
    switch (method) {
      case "values":
        return readValues(modId);
      // `page` is the writing page's id, so it doesn't hear its own change back.
      case "set": {
        const [k, value, page] = args;
        await update(modId, (v) => (v[k] = value));
        broadcast(modId, k, value, false, page);
        return null;
      }
      case "delete": {
        const [k, page] = args;
        await update(modId, (v) => delete v[k]);
        broadcast(modId, k, null, true, page);
        return null;
      }
      case "openInTab": {
        const [url, active] = args;
        if (!/^https?:/i.test(url)) throw new Error(`can only open http and https URLs, not ${url}`);
        const opener = sender.tab;
        const tab = await chrome.tabs.create({ url, active: Boolean(active), ...(opener ? { index: opener.index + 1, openerTabId: opener.id, windowId: opener.windowId } : {}) });
        openedTabs.set(tab.id, modId);
        return tab.id;
      }
      case "closeTab": {
        const [id] = args;
        if (openedTabs.get(id) !== modId) throw new Error("can only close tabs this script opened");
        openedTabs.delete(id);
        await chrome.tabs.remove(id).catch(() => {});
        return null;
      }
      case "notification": {
        // `n` is the page's id for it, used to call its onclick/ondone back.
        const [{ title, text, image, silent, highlight, timeout, tag } = {}, n, wants = {}] = args;
        await notificationsLoaded;
        const id = `gm:${modId}:${tag ? `tag:${String(tag).slice(0, 100)}` : `${Date.now()}:${++notificationSeq}`}`;
        const opts = { type: "basic", iconUrl: image || "icons/icon128.png", title: String(title || mod.name), message: String(text ?? "") || " ", silent: Boolean(silent) };
        // A notification with the same tag replaces the last one, which is done.
        if (notifications.has(id)) await finishNotification(id, false);
        notifications.set(id, { modId, n, tabId, documentId: sender.documentId, highlight: Boolean(highlight), wants });
        saveNotifications();
        await chrome.notifications.create(id, opts).catch(() => chrome.notifications.create(id, { ...opts, iconUrl: "icons/icon128.png" }));
        if (timeout > 0) setTimeout(() => chrome.notifications.clear(id).catch(() => {}), Math.min(Number(timeout), 600_000));
        return id;
      }
      case "notificationRemove": {
        const [id] = args;
        if (notifications.get(id)?.modId === modId) await chrome.notifications.clear(id).catch(() => {});
        return null;
      }
      case "cookie": {
        const [op, details = {}] = args;
        return cookie(mod, op, details, sender.url ?? details.pageUrl);
      }
      case "getTab": {
        if (tabId == null) return {};
        return (await readTabs(modId))[tabId] ?? {};
      }
      case "saveTab": {
        if (tabId == null) return null;
        const [obj] = args;
        await updateTabs(modId, (tabs) => (tabs[tabId] = obj ?? {}));
        return null;
      }
      case "getTabs": {
        // Only tabs that still exist.
        const tabs = await readTabs(modId);
        const open = new Set((await chrome.tabs.query({}).catch(() => [])).map((t) => String(t.id)));
        return Object.fromEntries(Object.entries(tabs).filter(([id]) => open.has(id)));
      }
      case "menuRegister":
      case "menuUnregister": {
        if (tabId == null) return null;
        await menusLoaded;
        const [id, caption] = args;
        setMenu(tabId, { modId, id: String(id), caption: String(caption ?? ""), frameId: sender.frameId, documentId: sender.documentId, at: Date.now() }, method === "menuUnregister");
        return null;
      }
    }
    throw new Error(`unknown method ${method}`);
  }

  /** chrome.runtime.onUserScriptMessage, for { type: "gm" } messages. */
  function onMessage(msg, sender, sendResponse) {
    handle(msg, sender).then(
      (result) => sendResponse({ result }),
      (e) => sendResponse({ error: String(e?.message ?? e) }),
    );
    return true;
  }

  // ---------- optional permissions ----------
  // GM_download and GM_cookie need permissions Eyepatch doesn't ask for at
  // install; Settings asks when a mod that uses them is there.

  async function needPermission(permission, what) {
    if (await chrome.permissions.contains({ permissions: [permission] }).catch(() => false)) return;
    const err = new Error(`${what} needs permission: allow it next to the mod in Eyepatch's Settings`);
    err.code = "not_permitted";
    throw err;
  }

  // ---------- GM_cookie ----------

  const COOKIE_FIELDS = ["domain", "expirationDate", "hostOnly", "httpOnly", "name", "path", "sameSite", "secure", "session", "storeId", "value"];

  /** list, set or delete cookies of the page's site or an @connect host. */
  async function cookie(mod, op, details, pageUrl) {
    await needPermission("cookies", "GM_cookie");
    const url = details.url ? new URL(details.url, pageUrl) : new URL(pageUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error(`only http and https cookies, not ${url.protocol}`);
    if (!connectAllowed(mod, url, pageUrl)) throw new Error(`blocked: add "// @connect ${url.hostname}" to the script's header`);
    if (details.domain) {
      const d = String(details.domain).replace(/^\./, "").toLowerCase();
      if (!connectAllowed(mod, new URL(`${url.protocol}//${d}/`), pageUrl)) throw new Error(`blocked: add "// @connect ${d}" to the script's header`);
    }
    const pick = (c) => Object.fromEntries(COOKIE_FIELDS.filter((k) => k in c).map((k) => [k, c[k]]));
    switch (op) {
      case "list": {
        const query = details.domain ? { domain: details.domain } : { url: url.href };
        if (details.name != null) query.name = String(details.name);
        if (details.path != null) query.path = String(details.path);
        return (await chrome.cookies.getAll(query)).map(pick);
      }
      case "set": {
        const c = { url: url.href, name: String(details.name ?? ""), value: String(details.value ?? "") };
        for (const k of ["domain", "path", "secure", "httpOnly", "expirationDate", "sameSite"]) if (details[k] != null) c[k] = details[k];
        const set = await chrome.cookies.set(c);
        if (!set) throw new Error("the cookie wasn't set");
        return null;
      }
      case "delete":
        await chrome.cookies.remove({ url: url.href, name: String(details.name ?? "") });
        return null;
    }
    throw new Error(`unknown GM_cookie method ${op}`);
  }

  // ---------- GM_download ----------

  /** A file name Chrome will take: relative, no "..", no characters file systems refuse. */
  function downloadName(name, url) {
    let n = String(name || "").replace(/\\/g, "/");
    if (!n && url) n = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    n = n
      .split("/")
      .map((part) => part.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_").trim())
      .filter(Boolean)
      .join("/");
    return n || undefined;
  }

  /** chrome.runtime.onUserScriptConnect, for "gm-download" ports: one download each. */
  function onDownloadConnect(port) {
    let downloadId = null;
    let listener = null;
    let timer = null;
    const post = (m) => {
      try {
        port.postMessage(m);
      } catch {}
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (listener) chrome.downloads?.onChanged.removeListener(listener);
      listener = null;
    };
    port.onDisconnect.addListener(cleanup);
    port.onMessage.addListener(async (msg) => {
      if (msg.abort) {
        cleanup();
        if (downloadId != null) chrome.downloads.cancel(downloadId).catch(() => {});
        return;
      }
      try {
        await modsLoaded;
        const mod = getMod(msg.mod);
        if (!mod || mod.token !== msg.token) throw new Error(`mod ${msg.mod} isn't running`);
        if (!mod.grants?.includes("download")) throw new Error("needs @grant GM_download");
        await needPermission("downloads", "GM_download");
        const req = msg.request;
        let url;
        if (req.body) url = `data:${req.body.type};base64,${req.body.base64}`;
        else {
          const u = new URL(req.url);
          if (!/^https?:$/.test(u.protocol)) throw new Error(`only http and https URLs, not ${u.protocol}`);
          if (!connectAllowed(mod, u, port.sender?.url)) throw new Error(`blocked: add "// @connect ${u.hostname}" to the script's header`);
          url = u.href;
        }
        const headers = Object.entries(req.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
        const options = { url, saveAs: req.saveAs, filename: downloadName(req.name, req.url) };
        if (headers.length && !req.body) options.headers = headers;
        if (["uniquify", "overwrite", "prompt"].includes(req.conflictAction)) options.conflictAction = req.conflictAction;
        listener = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state?.current === "complete") {
            cleanup();
            post({ type: "load" });
          } else if (delta.state?.current === "interrupted" || delta.error) {
            cleanup();
            const code = delta.error?.current ?? "interrupted";
            post({ type: "error", error: code, code: code === "USER_CANCELED" ? "aborted" : "download_failed" });
          }
        };
        chrome.downloads.onChanged.addListener(listener);
        downloadId = await chrome.downloads.download(options);
        if (req.timeout > 0) {
          timer = setTimeout(() => {
            cleanup();
            chrome.downloads.cancel(downloadId).catch(() => {});
            post({ type: "timeout" });
          }, req.timeout);
        }
      } catch (e) {
        cleanup();
        post({ type: "error", error: String(e?.message ?? e), code: e?.code });
      }
    });
  }

  // ---------- GM_xmlhttpRequest ----------

  /** Whether `@connect` lets the mod reach this URL from this page. */
  function connectAllowed(mod, url, pageUrl) {
    const host = url.hostname.toLowerCase();
    let pageHost = "";
    try {
      pageHost = new URL(pageUrl).hostname.toLowerCase();
    } catch {}
    if (host === pageHost) return true;
    return (mod.connects ?? []).some((c) => {
      if (c === "*") return true;
      if (c === "self") return host === pageHost;
      if (c === "localhost") return ["localhost", "127.0.0.1", "[::1]"].includes(host);
      const d = c.replace(/^\*\./, "");
      return host === d || host.endsWith("." + d);
    });
  }

  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const toBase64 = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  function decodeBody(body, headers) {
    if (!body) return undefined;
    if (body.type && !headers.has("content-type")) headers.set("content-type", body.type);
    if (body.text != null) return body.text;
    if (body.base64 != null) return fromBase64(body.base64);
    if (body.form) {
      const form = new FormData();
      for (const [k, v] of body.form) {
        if (typeof v === "string") form.append(k, v);
        else form.append(k, new Blob([fromBase64(v.base64)], { type: v.type }), v.name);
      }
      return form;
    }
    return undefined;
  }

  // ---------- headers fetch won't send ----------
  // fetch drops forbidden headers (Cookie, Referer, User-Agent, Origin...)
  // that userscripts set. A declarativeNetRequest session rule sets them on
  // the extension's own request to that URL while it's in flight. Requests
  // to the same URL that set such headers wait for each other.

  // Transport-level ones stay the browser's.
  const UNSETTABLE = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "expect"]);
  const FORBIDDEN = new Set(["accept-charset", "accept-encoding", "cookie", "cookie2", "date", "dnt", "origin", "referer", "user-agent", "via"]);
  const needsRule = (name) => {
    const n = name.toLowerCase();
    return !UNSETTABLE.has(n) && (FORBIDDEN.has(n) || n.startsWith("sec-") || n.startsWith("proxy-") || n.startsWith("access-control-request-"));
  };
  const RULE_BASE = 100_000; // dynamic rule 1 is the install redirect (background.js)
  let ruleSeq = 0;
  const urlLocks = new Map(); // url -> promise of the request holding its rule

  /** Run `fn` with `headers` set on requests to `url`; resolves with fn's result. */
  async function withHeaderRule(url, method, headers, fn) {
    if (!headers.length) return fn();
    const prev = urlLocks.get(url) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    urlLocks.set(url, prev.then(() => mine));
    await prev;
    const id = RULE_BASE + (ruleSeq = (ruleSeq + 1) % 100_000);
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id],
        addRules: [
          {
            id,
            priority: 1,
            action: { type: "modifyHeaders", requestHeaders: headers.map(([header, value]) => ({ header, operation: "set", value: String(value) })) },
            condition: {
              regexFilter: `^${escaped}$`,
              resourceTypes: ["xmlhttprequest", "other"],
              requestMethods: [method.toLowerCase()],
              tabIds: [chrome.tabs.TAB_ID_NONE],
              initiatorDomains: [chrome.runtime.id],
            },
          },
        ],
      });
      return await fn();
    } finally {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
      release();
      if (urlLocks.get(url) === mine) urlLocks.delete(url);
    }
  }
  // Rules left by a service worker that stopped mid-request.
  chrome.declarativeNetRequest
    .getSessionRules()
    .then((rules) => {
      const ids = rules.filter((r) => r.id >= RULE_BASE).map((r) => r.id);
      if (ids.length) return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    })
    .catch(() => {});

  /** chrome.runtime.onUserScriptConnect, for "gm-xhr" ports: one request each. */
  function onConnect(port) {
    if (port.name === "gm-download") return onDownloadConnect(port);
    if (port.name !== "gm-xhr") return;
    const controller = new AbortController();
    let timedOut = false;
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener(async (msg) => {
      if (msg.abort) return controller.abort();
      const post = (m) => {
        try {
          port.postMessage(m);
        } catch {}
      };
      try {
        await modsLoaded;
        const mod = getMod(msg.mod);
        if (!mod || mod.token !== msg.token) throw new Error(`mod ${msg.mod} isn't running`);
        if (!mod.grants?.includes("xmlhttpRequest")) throw new Error("needs @grant GM_xmlhttpRequest");
        const req = msg.request;
        const url = new URL(req.url);
        if (!/^https?:$/.test(url.protocol)) throw new Error(`only http and https URLs, not ${url.protocol}`);
        if (!connectAllowed(mod, url, port.sender?.url)) throw new Error(`blocked: add "// @connect ${url.hostname}" to the script's header`);
        const headers = new Headers();
        const ruled = [];
        for (const [k, v] of Object.entries(req.headers ?? {})) {
          if (needsRule(k)) {
            ruled.push([k, v]);
            continue;
          }
          try {
            headers.set(k, String(v));
          } catch {}
        }
        const body = ["GET", "HEAD"].includes(req.method) ? undefined : decodeBody(req.body, headers);
        const timer = req.timeout > 0 ? setTimeout(() => ((timedOut = true), controller.abort()), req.timeout) : null;
        // The cookies sent are the target site's, as in other userscript
        // managers (anonymous: true sends none); @connect limits the sites.
        const res = await withHeaderRule(url.href, req.method, ruled, () =>
          fetch(url, {
            method: req.method,
            headers,
            body,
            credentials: req.anonymous ? "omit" : "include",
            redirect: req.redirect === "manual" || req.redirect === "error" ? req.redirect : "follow",
            cache: req.nocache ? "no-store" : "default",
            signal: controller.signal,
          }),
        );
        // Redirects are followed by fetch; a script can't read a response
        // from a site its @connect doesn't allow.
        const finalUrl = new URL(res.url || url);
        if (!connectAllowed(mod, finalUrl, port.sender?.url)) throw new Error(`blocked: redirected to ${finalUrl.hostname}; add "// @connect ${finalUrl.hostname}" to the script's header`);
        const headerText = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\r\n");
        post({ type: "headers", status: res.status, statusText: res.statusText, headers: headerText, finalUrl: res.url });
        const bytes = new Uint8Array(await res.arrayBuffer());
        clearTimeout(timer);
        const mimeType = res.headers.get("content-type") ?? "";
        const charset = /charset=([^;]+)/i.exec(mimeType)?.[1]?.trim();
        let text;
        if (!req.binary) {
          try {
            text = new TextDecoder(charset || "utf-8").decode(bytes);
          } catch {
            text = new TextDecoder().decode(bytes);
          }
        }
        post({
          type: "load",
          status: res.status,
          statusText: res.statusText,
          headers: headerText,
          finalUrl: res.url,
          mimeType,
          ...(req.binary ? { base64: toBase64(bytes) } : { text }),
        });
      } catch (e) {
        post(timedOut ? { type: "timeout" } : { type: "error", error: String(e?.message ?? e) });
      }
    });
  }

  return { setMods, channelFor, readValues, onMessage, onConnect, menusFor, runMenu, navigationStarted, pruneMenus, forgetTab, forget };
}

// Mods → user scripts. Agent Bridge parses each .user.js / .user.css file
// (agent-bridge/src/modfile.ts) and sends the result; this turns it into the
// code chrome.userScripts registers. Functions whose source is injected into
// pages (gmRuntime, ruleMatches) must not reference anything outside
// themselves.

import { ruleMatches } from "./match.js";
import { pageBridge, windowProxy } from "./unsafe-window.js";

export const styleId = (modId) => `eyepatch-${modId}`;

/** Returns early from the injected code if the page isn't one the mod's filter allows. */
function filterGuard(mod) {
  if (!mod.filter) return "";
  return `const ruleMatches = ${ruleMatches};
  const filter = ${JSON.stringify(mod.filter)};
  if (!filter.any.some((r) => ruleMatches(r, location.href)) || filter.none.some((r) => ruleMatches(r, location.href))) return;`;
}

/**
 * A UserCSS mod's styles: the sections that apply to this page, in one
 * <style>. Re-running it updates the styles in place (hot swap), or removes
 * them when no section applies.
 */
export function cssCode(mod) {
  return `(() => {
  const ruleMatches = ${ruleMatches};
  const sections = ${JSON.stringify(mod.sections ?? [])};
  const href = location.href;
  const css = sections.filter((s) => !s.rules.length || s.rules.some((r) => ruleMatches(r, href))).map((s) => s.css).join("\\n");
  const id = ${JSON.stringify(styleId(mod.id))};
  let s = document.getElementById(id);
  if (!css) return s?.remove();
  if (!s) {
    s = document.createElement("style");
    s.id = id;
    (document.head || document.documentElement).appendChild(s);
  }
  s.textContent = css;
})();`;
}

export function removeCssCode(modId) {
  return `document.getElementById(${JSON.stringify(styleId(modId))})?.remove();`;
}

/** Tells the extension the mod ran in this page, for the toolbar badge. */
export function reportCode(mod) {
  return `(() => {
  ${filterGuard(mod)}
  const report = () => chrome.runtime.sendMessage({ type: "mod_ran", id: ${JSON.stringify(mod.id)} }).catch(() => {});
  report();
  addEventListener("pageshow", (e) => e.persisted && report()); // back/forward cache
})();`;
}

/**
 * The isolated world a userscript runs in. Each mod gets its own, so mods
 * can't see or change each other's globals, or reach each other's GM API
 * token (only code in the mod's world has it).
 */
export const worldIdOf = (modId) => `mod:${modId}`;

/** The GM functions a userscript's code sees as locals. */
const GM_NAMES = [
  "GM", "GM_info", "unsafeWindow",
  "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "GM_getValues", "GM_setValues", "GM_deleteValues",
  "GM_addValueChangeListener", "GM_removeValueChangeListener",
  "GM_addStyle", "GM_addElement", "GM_getResourceText", "GM_getResourceURL",
  "GM_xmlhttpRequest", "GM_openInTab", "GM_notification", "GM_setClipboard",
  "GM_registerMenuCommand", "GM_unregisterMenuCommand", "GM_log",
  "GM_getTab", "GM_saveTab", "GM_getTabs", "GM_download", "GM_cookie",
];

/** GM functions that use the mod's stored values. */
export const STORAGE_GRANTS = ["getValue", "setValue", "deleteValue", "listValues", "getValues", "setValues", "deleteValues", "addValueChangeListener"];
export const usesStorage = (mod) => STORAGE_GRANTS.some((g) => mod.grants?.includes(g));

/**
 * A userscript, run the way userscript managers run them: inside a function
 * whose parameters are its GM API, after its @require files. `token` lets
 * its GM API reach the extension (see gm.js). `channel` names the bridge to
 * the page's window, for unsafeWindow (see unsafe-window.js).
 */
export function jsCode(mod, version, token, channel) {
  const granted = (mod.info?.script?.grant ?? []).flatMap((g) => g.split(/\s+/)).filter((g) => /^GM[._]\w+$/.test(g));
  // Granted but unsupported GM_ functions become stubs that say so.
  const stubs = granted.filter((g) => g.startsWith("GM_") && !GM_NAMES.includes(g));
  const names = [...GM_NAMES, ...new Set(stubs)];
  const cfg = {
    id: mod.id,
    token,
    name: mod.name,
    world: mod.world,
    grants: mod.grants ?? [],
    granted,
    resources: mod.resources ?? {},
    filter: mod.filter ?? null,
    info: { ...(mod.info ?? {}), version },
    unsafeChannel: channel ?? null,
  };
  return `(${gmRuntime})(${ruleMatches}, ${windowProxy}, ${JSON.stringify(cfg)}, ${JSON.stringify(names)}, function (${names.join(", ")}) {
${(mod.requires ?? []).join("\n;\n")}
${mod.js ?? ""}
});`;
}

/**
 * The mod's stored values, set in its world just before its code runs, so
 * GM_getValue works synchronously even at document-start. Re-registered when
 * values change (see gm.js); the page then also asks for the latest.
 */
export const valuesCode = (values) => `globalThis.__eyepatchValues = ${JSON.stringify(values ?? {})};`;

/** Whether a script (or its @require files) uses unsafeWindow. */
const usesUnsafeWindow = (mod) => [mod.js ?? "", ...(mod.requires ?? [])].some((code) => code.includes("unsafeWindow"));

/**
 * `token` and `values` are only used by scripts with GM grants; `channelId`
 * (stable per mod) by scripts that use unsafeWindow.
 */
export function scriptsFor(mod, version, token, values, channelId) {
  if (mod.error || !mod.enabled) return [];
  const common = { matches: mod.matches, excludeMatches: mod.excludeMatches ?? [] };
  const out = [{ ...common, id: `mod:${mod.id}:ran`, js: [{ code: reportCode(mod) }], runAt: "document_start", world: "USER_SCRIPT" }];
  if (mod.kind === "css") {
    out.push({ ...common, id: `mod:${mod.id}:css`, js: [{ code: cssCode(mod) }], runAt: "document_start", world: "USER_SCRIPT", allFrames: mod.allFrames });
  } else {
    const world = mod.world === "main" ? { world: "MAIN" } : { world: "USER_SCRIPT", worldId: worldIdOf(mod.id) };
    // In an isolated world, unsafeWindow reaches the page's window through a
    // bridge that runs in the page first (registered before the script).
    const channel = mod.world !== "main" && channelId && usesUnsafeWindow(mod) ? `eyepatch-uw-${channelId}` : null;
    if (channel) {
      out.push({ ...common, id: `mod:${mod.id}:page`, js: [{ code: `(${pageBridge})(${JSON.stringify(channel)});` }], runAt: "document_start", allFrames: mod.allFrames, world: "MAIN" });
    }
    const js = [{ code: jsCode(mod, version, token, channel) }];
    if (mod.world !== "main" && usesStorage(mod)) js.unshift({ code: valuesCode(values) });
    out.push({ ...common, id: `mod:${mod.id}:js`, js, runAt: mod.runAt, allFrames: mod.allFrames, ...world });
  }
  return out;
}

/**
 * Runs in the page: builds a userscript's GM API and calls its code with it.
 * In its isolated world the API reaches the extension through
 * chrome.runtime messaging (see gm.js); in the page's own world only the
 * functions that need nothing from the extension work.
 */
export function gmRuntime(ruleMatches, windowProxy, cfg, names, body) {
  const href = location.href;
  if (cfg.filter && (!cfg.filter.any.some((r) => ruleMatches(r, href)) || cfg.filter.none.some((r) => ruleMatches(r, href)))) return;

  const tag = `[mod ${cfg.id}]`;
  const isolated = cfg.world !== "main" && typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
  const grants = new Set(cfg.grants);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const logError = (e) => console.error(tag, e);
  /** Records an exception with the mod's id, for get_console_logs. */
  const report = (e) => {
    (globalThis.__eyepatchConsole ||= []).push({ t: Date.now(), world: cfg.world === "main" ? "page" : "mods", level: "uncaught", text: `${tag} ${e?.stack || e}` });
  };
  const call = (method, ...args) => {
    if (!isolated) return Promise.reject(new Error(`${method} isn't available to scripts that run in the page (@inject-into page)`));
    return chrome.runtime.sendMessage({ type: "gm", mod: cfg.id, token: cfg.token, method, args }).then((r) => {
      if (r?.error) throw new Error(r.error);
      return r?.result;
    });
  };
  const toBase64 = (bytes) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // ---- storage: the values registered with the script, kept in sync ----
  let values = globalThis.__eyepatchValues ?? {};
  delete globalThis.__eyepatchValues;
  const listeners = new Map();
  let listenerSeq = 0;
  const changed = (key, oldValue, newValue, remote) => {
    for (const l of listeners.values()) {
      if (l.key !== key) continue;
      try {
        l.cb(key, clone(oldValue), clone(newValue), remote);
      } catch (e) {
        logError(e);
      }
    }
  };
  /** A change made elsewhere (another tab, or before this page's values were registered). */
  const pageId = Math.random().toString(36).slice(2);
  const remoteChange = (key, value, deleted, from) => {
    if (from === pageId) return;
    const had = Object.prototype.hasOwnProperty.call(values, key);
    if (deleted ? !had : had && same(values[key], value)) return;
    const old = values[key];
    if (deleted) delete values[key];
    else values[key] = value;
    changed(key, old, deleted ? undefined : value, true);
  };
  const getValue = (key, def) => (Object.prototype.hasOwnProperty.call(values, key) ? clone(values[key]) : def);
  const setValue = (key, value) => {
    if (value === undefined) return deleteValue(key);
    const old = values[key];
    const next = clone(value);
    values[key] = next;
    call("set", key, next, pageId).catch(logError);
    if (!same(old, next)) changed(key, old, next, false);
  };
  const deleteValue = (key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return;
    const old = values[key];
    delete values[key];
    call("delete", key, pageId).catch(logError);
    changed(key, old, undefined, false);
  };
  const listValues = () => Object.keys(values);
  const getValues = (keys) => {
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, clone(values[k])]));
    return Object.fromEntries(Object.entries(keys ?? {}).map(([k, d]) => [k, getValue(k, d)]));
  };
  const setValues = (obj) => Object.entries(obj ?? {}).forEach(([k, v]) => setValue(k, v));
  const deleteValues = (keys) => (keys ?? []).forEach(deleteValue);
  const addValueChangeListener = (key, cb) => {
    const id = String(++listenerSeq);
    listeners.set(id, { key, cb });
    return id;
  };
  const removeValueChangeListener = (id) => listeners.delete(String(id));
  // The registered values can be a moment behind; catch up.
  if (isolated && ["getValue", "setValue", "deleteValue", "listValues", "getValues", "setValues", "deleteValues", "addValueChangeListener"].some((g) => grants.has(g))) {
    call("values").then((latest) => {
      latest ??= {};
      for (const k of Object.keys(values)) if (!(k in latest)) remoteChange(k, null, true);
      for (const [k, v] of Object.entries(latest)) remoteChange(k, v, false);
    }, logError);
  }

  // ---- menu commands, shown in the side panel's menu ----
  const menu = new Map();
  let menuSeq = 0;
  const registerMenuCommand = (caption, fn, opts) => {
    const id = String((opts && typeof opts === "object" && opts.id) || `c${++menuSeq}`);
    menu.set(id, fn);
    call("menuRegister", id, String(caption)).catch(logError);
    return id;
  };
  const unregisterMenuCommand = (id) => {
    menu.delete(String(id));
    call("menuUnregister", String(id)).catch(logError);
  };

  // The extension reaches the script through a global in its own world.
  if (isolated) {
    globalThis.__eyepatchGM = {
      value: remoteChange,
      notified: (n, event) => notified(n, event), // defined below
      menu(id) {
        try {
          menu.get(id)?.();
        } catch (e) {
          logError(e);
        }
      },
    };
  }

  // ---- the DOM ----
  const addStyle = (css) => {
    const s = document.createElement("style");
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
    return s;
  };
  const addElement = (...args) => {
    const parent = typeof args[0] === "string" ? null : args.shift();
    const [tagName, attrs] = args;
    const el = document.createElement(tagName);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (k === "textContent") el.textContent = v;
      else el.setAttribute(k, v);
    }
    (parent || document.head || document.documentElement).appendChild(el);
    return el;
  };
  const getResourceText = (name) => {
    const r = cfg.resources[name];
    return r ? new TextDecoder().decode(fromBase64(r.base64)) : null;
  };
  const getResourceURL = (name) => {
    const r = cfg.resources[name];
    return r ? `data:${r.mimeType};base64,${r.base64}` : null;
  };
  const setClipboard = (data, info) => {
    const text = String(data);
    const html = info === "html" || info?.type === "html" || info?.mimetype === "text/html";
    const fallback = () => {
      const t = document.createElement("textarea");
      t.value = text;
      t.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.documentElement.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    };
    const write = html
      ? navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([text], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })])
      : navigator.clipboard.writeText(text);
    return write.catch(fallback);
  };

  // ---- the extension: tabs and notifications ----
  const openInTab = (url, opts) => {
    const active = typeof opts === "boolean" ? !opts : opts?.active ?? (opts?.loadInBackground != null ? !opts.loadInBackground : true);
    const tab = call("openInTab", new URL(url, location.href).href, active);
    const handle = {
      closed: false,
      onclose: null,
      close() {
        handle.closed = true;
        tab.then((id) => call("closeTab", id)).catch(logError);
      },
    };
    tab.catch(logError);
    return handle;
  };
  // GM_notification(details) or (text, title, image, onclick). Returns a
  // handle with remove(); GM.notification resolves once it's gone.
  const shown = new Map(); // the page's id -> { details, id (the extension's), done }
  let notificationSeq = 0;
  const notification = (details, ...rest) => {
    const d = typeof details === "string" ? { text: details, title: rest[0], image: rest[1], onclick: rest[2] } : { ...(details ?? {}) };
    const n = String(++notificationSeq);
    let resolveDone;
    const entry = { details: d, done: new Promise((r) => (resolveDone = r)), resolveDone };
    shown.set(n, entry);
    const wants = { click: typeof d.onclick === "function", done: true };
    const image = typeof d.image === "string" ? new URL(d.image, location.href).href : undefined;
    const created = call("notification", { title: d.title, text: d.text, image, silent: d.silent, highlight: d.highlight, timeout: d.timeout, tag: d.tag }, n, wants);
    created.catch((e) => {
      logError(e);
      shown.delete(n);
      entry.resolveDone(false);
    });
    return {
      remove: () => created.then((id) => call("notificationRemove", id)).catch(logError),
      done: entry.done,
    };
  };
  const notified = (n, event) => {
    const entry = shown.get(n);
    if (!entry) return;
    const fire = (name) => {
      try {
        entry.details[name]?.({ event: name });
      } catch (e) {
        logError(e);
      }
    };
    if (event === "click") return fire("onclick");
    shown.delete(n);
    fire("ondone");
    entry.resolveDone(true);
  };

  // ---- downloads (the optional "downloads" permission, allowed in Settings) ----
  // GM_download(details) or (url, name). Returns { abort() }.
  const download = (details, name) => {
    const d = typeof details === "string" ? { url: details, name } : { ...(details ?? {}) };
    let done = false;
    let port;
    const fire = (k, v) => {
      try {
        d[k]?.(v);
      } catch (e) {
        logError(e);
      }
    };
    const finish = (k, v) => {
      if (done) return;
      done = true;
      fire(k, v);
      try {
        port?.disconnect();
      } catch {}
    };
    if (!isolated) {
      setTimeout(() => finish("onerror", { error: "not_supported", details: "GM_download isn't available to scripts that run in the page (@inject-into page)" }));
      return { abort() {} };
    }
    const url = d.url instanceof Blob ? URL.createObjectURL(d.url) : new URL(String(d.url), location.href).href;
    // blob: and data: URLs are read here; the extension can't open the page's.
    const body = /^(blob|data):/i.test(url)
      ? fetch(url).then(async (r) => ({ type: r.headers.get("content-type") || "application/octet-stream", base64: toBase64(new Uint8Array(await r.arrayBuffer())) }))
      : Promise.resolve(null);
    port = chrome.runtime.connect({ name: "gm-download" });
    port.onMessage.addListener((m) => {
      if (m.type === "load") finish("onload", { url, name: d.name });
      else if (m.type === "timeout") finish("ontimeout", {});
      else if (m.type === "error") {
        console.warn(tag, `GM_download ${url}: ${m.error}`);
        finish("onerror", { error: m.code ?? "unknown", details: m.error });
      } else if (m.type === "progress") fire("onprogress", { loaded: m.loaded, total: m.total, lengthComputable: m.total > 0 });
    });
    port.onDisconnect.addListener(() => finish("onerror", { error: "disconnected", details: "disconnected" }));
    body.then(
      (b) =>
        !done &&
        port.postMessage({
          mod: cfg.id,
          token: cfg.token,
          request: { url: b ? null : url, body: b, name: d.name, headers: d.headers ?? {}, saveAs: Boolean(d.saveAs), conflictAction: d.conflictAction, timeout: d.timeout || 0 },
        }),
      (e) => finish("onerror", { error: "read_failed", details: String(e) }),
    );
    return {
      abort() {
        if (done) return;
        try {
          port.postMessage({ abort: true });
        } catch {}
        finish("onerror", { error: "aborted", details: "aborted" });
      },
    };
  };
  const downloadPromise = (details, name) => {
    const d = typeof details === "string" ? { url: details, name } : { ...(details ?? {}) };
    let handle;
    const p = new Promise((resolve, reject) => {
      handle = download({
        ...d,
        onload: (r) => (d.onload?.(r), resolve(r)),
        onerror: (r) => (d.onerror?.(r), reject(r)),
        ontimeout: (r) => (d.ontimeout?.(r), reject(r)),
      });
    });
    p.abort = () => handle.abort();
    return p;
  };

  // ---- cookies (the optional "cookies" permission, allowed in Settings) ----
  // GM_cookie.list/set/delete(details, cb), cb(result, error); GM.cookie.* return promises.
  const cookieCall = (op, details) => call("cookie", op, { ...(details ?? {}), pageUrl: location.href });
  const cookieFn = (op) => (details, cb) => {
    const p = cookieCall(op, details);
    if (typeof cb === "function") p.then((r) => cb(r, undefined), (e) => cb(undefined, String(e?.message ?? e)));
    else p.catch(logError);
  };
  const cookie = { list: cookieFn("list"), set: cookieFn("set"), delete: cookieFn("delete") };
  const cookiePromises = { list: (d) => cookieCall("list", d), set: (d) => cookieCall("set", d), delete: (d) => cookieCall("delete", d) };

  // ---- per-tab objects ----
  const getTab = (cb) => {
    const p = call("getTab");
    if (typeof cb === "function") p.then((t) => cb(t), logError);
    return p;
  };
  const saveTab = (obj) => call("saveTab", clone(obj ?? {})).catch(logError);
  const getTabs = (cb) => {
    const p = call("getTabs");
    if (typeof cb === "function") p.then((t) => cb(t), logError);
    return p;
  };

  // ---- cross-origin requests ----
  const encodeBody = async (data) => {
    if (data == null) return null;
    if (typeof data === "string") return { text: data };
    if (data instanceof URLSearchParams) return { text: data.toString(), type: "application/x-www-form-urlencoded;charset=UTF-8" };
    if (data instanceof Blob) return { base64: toBase64(new Uint8Array(await data.arrayBuffer())), type: data.type };
    if (data instanceof ArrayBuffer) return { base64: toBase64(new Uint8Array(data)) };
    if (ArrayBuffer.isView(data)) return { base64: toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
    if (data instanceof FormData) {
      const form = [];
      for (const [k, v] of data) {
        form.push(typeof v === "string" ? [k, v] : [k, { name: v.name, type: v.type, base64: toBase64(new Uint8Array(await v.arrayBuffer())) }]);
      }
      return { form };
    }
    return { text: typeof data === "object" ? JSON.stringify(data) : String(data) };
  };
  const xmlhttpRequest = (details) => {
    const responseType = String(details.responseType || "").toLowerCase();
    const url = new URL(details.url, location.href).href;
    let done = false;
    let port;
    const respond = (m) => {
      const bytes = m.base64 != null ? fromBase64(m.base64) : null;
      const text = m.text ?? null;
      const parse = () => new DOMParser().parseFromString(text, /xml/.test(m.mimeType) ? "text/xml" : "text/html");
      let response = text;
      if (responseType === "json") {
        try {
          response = JSON.parse(text);
        } catch {
          response = undefined;
        }
      } else if (responseType === "arraybuffer") response = bytes.buffer;
      else if (responseType === "blob") response = new Blob([bytes], { type: m.mimeType });
      else if (responseType === "document") response = parse();
      return {
        readyState: 4,
        status: m.status,
        statusText: m.statusText,
        responseHeaders: m.headers,
        finalUrl: m.finalUrl,
        response,
        get responseText() {
          return text ?? (bytes ? new TextDecoder().decode(bytes) : "");
        },
        get responseXML() {
          return text != null && /xml|html/.test(m.mimeType) ? parse() : null;
        },
        context: details.context,
      };
    };
    const failure = (error) => ({ readyState: 4, status: 0, statusText: "", responseHeaders: "", response: null, responseText: "", finalUrl: url, error, context: details.context });
    const fire = (name, res) => {
      try {
        details[name]?.(res);
      } catch (e) {
        logError(e);
      }
    };
    const finish = (kind, res) => {
      if (done) return;
      done = true;
      if (kind === "load") {
        fire("onreadystatechange", res);
        fire("onload", res);
      } else fire(`on${kind}`, res);
      fire("onloadend", res);
      try {
        port?.disconnect();
      } catch {}
    };
    if (!isolated) {
      setTimeout(() => finish("error", failure("GM_xmlhttpRequest isn't available to scripts that run in the page (@inject-into page)")));
      return { abort() {} };
    }
    port = chrome.runtime.connect({ name: "gm-xhr" });
    port.onMessage.addListener((m) => {
      if (m.type === "headers") fire("onreadystatechange", { readyState: 2, status: m.status, statusText: m.statusText, responseHeaders: m.headers, finalUrl: m.finalUrl, context: details.context });
      else if (m.type === "load") finish("load", respond(m));
      else if (m.type === "timeout") finish("timeout", failure("timeout"));
      else {
        console.warn(tag, `GM_xmlhttpRequest ${url}: ${m.error}`);
        finish("error", failure(m.error));
      }
    });
    port.onDisconnect.addListener(() => finish("error", failure("disconnected")));
    encodeBody(details.data).then(
      (body) =>
        !done &&
        port.postMessage({
          mod: cfg.id,
          token: cfg.token,
          request: {
            url,
            method: String(details.method || "GET").toUpperCase(),
            headers: details.headers ?? {},
            body,
            binary: responseType === "arraybuffer" || responseType === "blob",
            timeout: details.timeout || 0,
            anonymous: Boolean(details.anonymous),
            redirect: details.redirect,
            nocache: Boolean(details.nocache),
          },
        }),
      (e) => finish("error", failure(String(e))),
    );
    fire("onloadstart", { readyState: 1, context: details.context });
    return {
      abort() {
        if (done) return;
        try {
          port.postMessage({ abort: true });
        } catch {}
        finish("abort", failure("aborted"));
      },
    };
  };
  const xmlHttpRequestPromise = (details) => {
    let handle;
    const p = new Promise((resolve, reject) => {
      handle = xmlhttpRequest({
        ...details,
        onload: (r) => (details.onload?.(r), resolve(r)),
        onerror: (r) => (details.onerror?.(r), reject(r)),
        ontimeout: (r) => (details.ontimeout?.(r), reject(r)),
        onabort: (r) => (details.onabort?.(r), reject(r)),
      });
    });
    p.abort = () => handle.abort();
    return p;
  };

  // ---- the API, limited to what the script @grants ----
  const info = cfg.info;
  const fns = {
    getValue, setValue, deleteValue, listValues, getValues, setValues, deleteValues,
    addValueChangeListener, removeValueChangeListener,
    addStyle, addElement, getResourceText, getResourceURL,
    xmlhttpRequest, openInTab, notification, setClipboard,
    registerMenuCommand, unregisterMenuCommand,
    getTab, saveTab, getTabs, download, cookie,
    log: (...a) => console.log(...a),
  };
  const asyncNames = { xmlhttpRequest: "xmlHttpRequest", getResourceURL: "getResourceUrl" };
  let pageWindow = window;
  if (cfg.unsafeChannel) {
    try {
      pageWindow = windowProxy(cfg.unsafeChannel);
    } catch (e) {
      logError(e);
    }
  }
  const api = { GM_info: info, unsafeWindow: pageWindow };
  const GM = { info };
  for (const [name, fn] of Object.entries(fns)) {
    if (!grants.has(name)) continue;
    api[`GM_${name}`] = fn;
    GM[asyncNames[name] ?? name] =
      name === "xmlhttpRequest" ? xmlHttpRequestPromise
        : name === "notification" ? (...a) => fn(...a).done
        : name === "download" ? downloadPromise
        : name === "cookie" ? cookiePromises
          : async (...a) => fn(...a);
  }
  // Granted functions Eyepatch doesn't have throw a clear error instead of being undefined.
  for (const g of cfg.granted) {
    const name = g.slice(3);
    const stub = () => {
      throw new Error(`${g} isn't supported in Eyepatch yet`);
    };
    if (g.startsWith("GM_") && !(g in api)) api[g] = stub;
    if (g.startsWith("GM.") && !(name in GM)) GM[name] = async () => stub();
  }
  api.GM = GM;

  try {
    body.apply(window, names.map((n) => api[n]));
  } catch (e) {
    report(e);
    throw e;
  }
}

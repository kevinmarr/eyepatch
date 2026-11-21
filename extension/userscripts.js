// Mods → user scripts. Agent Bridge parses each .user.js / .user.css file
// (agent-bridge/src/modfile.ts) and sends the result; this turns it into the
// code chrome.userScripts registers. Functions whose source is injected into
// pages (gmRuntime, ruleMatches) must not reference anything outside
// themselves.

import { ruleMatches } from "./match.js";

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
 * can't see or change each other's globals.
 */
export const worldIdOf = (modId) => `mod:${modId}`;

/** The GM functions Eyepatch has (the ones that need nothing from the extension). */
const GM_NAMES = ["GM", "GM_info", "unsafeWindow", "GM_addStyle", "GM_addElement", "GM_getResourceText", "GM_getResourceURL", "GM_setClipboard", "GM_log"];

/**
 * A userscript, run the way userscript managers run them: inside a function
 * whose parameters are its GM API, after its @require files.
 */
export function jsCode(mod, version) {
  const granted = (mod.info?.script?.grant ?? []).flatMap((g) => g.split(/\s+/)).filter((g) => /^GM[._]\w+$/.test(g));
  // Granted but unsupported GM_ functions become stubs that say so.
  const stubs = granted.filter((g) => g.startsWith("GM_") && !GM_NAMES.includes(g));
  const names = [...GM_NAMES, ...new Set(stubs)];
  const cfg = {
    id: mod.id,
    world: mod.world,
    grants: mod.grants ?? [],
    granted,
    resources: mod.resources ?? {},
    filter: mod.filter ?? null,
    info: { ...(mod.info ?? {}), version },
  };
  return `(${gmRuntime})(${ruleMatches}, ${JSON.stringify(cfg)}, ${JSON.stringify(names)}, function (${names.join(", ")}) {
${(mod.requires ?? []).join("\n;\n")}
${mod.js ?? ""}
});`;
}

export function scriptsFor(mod, version) {
  if (mod.error || !mod.enabled) return [];
  const common = { matches: mod.matches, excludeMatches: mod.excludeMatches ?? [] };
  const out = [{ ...common, id: `mod:${mod.id}:ran`, js: [{ code: reportCode(mod) }], runAt: "document_start", world: "USER_SCRIPT" }];
  if (mod.kind === "css") {
    out.push({ ...common, id: `mod:${mod.id}:css`, js: [{ code: cssCode(mod) }], runAt: "document_start", world: "USER_SCRIPT", allFrames: mod.allFrames });
  } else {
    const world = mod.world === "main" ? { world: "MAIN" } : { world: "USER_SCRIPT", worldId: worldIdOf(mod.id) };
    out.push({ ...common, id: `mod:${mod.id}:js`, js: [{ code: jsCode(mod, version) }], runAt: mod.runAt, allFrames: mod.allFrames, ...world });
  }
  return out;
}

/** Runs in the page: builds a userscript's GM API and calls its code with it. */
export function gmRuntime(ruleMatches, cfg, names, body) {
  const href = location.href;
  if (cfg.filter && (!cfg.filter.any.some((r) => ruleMatches(r, href)) || cfg.filter.none.some((r) => ruleMatches(r, href)))) return;

  const tag = `[mod ${cfg.id}]`;
  const grants = new Set(cfg.grants);
  /** Records an exception with the mod's id, for get_console_logs. */
  const report = (e) => {
    (globalThis.__smConsole ||= []).push({ t: Date.now(), world: cfg.world === "main" ? "page" : "mods", level: "uncaught", text: `${tag} ${e?.stack || e}` });
  };
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

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

  // ---- the API, limited to what the script @grants ----
  const info = cfg.info;
  const fns = { addStyle, addElement, getResourceText, getResourceURL, setClipboard, log: (...a) => console.log(...a) };
  const asyncNames = { getResourceURL: "getResourceUrl" };
  const api = { GM_info: info, unsafeWindow: window };
  const GM = { info };
  for (const [name, fn] of Object.entries(fns)) {
    if (!grants.has(name)) continue;
    api[`GM_${name}`] = fn;
    GM[asyncNames[name] ?? name] = async (...a) => fn(...a);
  }
  // Granted functions Eyepatch doesn't have throw a clear error instead of being undefined.
  for (const g of cfg.granted) {
    const name = g.slice(3);
    const stub = () => {
      throw new Error(`${g} isn't supported in Eyepatch yet`);
    };
    if (g.startsWith("GM_") && !(g in api)) api[g] = stub;
    if (g.startsWith("GM.") && !(name in GM) && !Object.values(asyncNames).includes(name)) GM[name] = async () => stub();
  }
  api.GM = GM;

  try {
    body.apply(window, names.map((n) => api[n]));
  } catch (e) {
    report(e);
    throw e;
  }
}

// End-to-end check of mods in a real browser: loads the extension in
// Playwright's Chromium, runs a real Agent Bridge on a temporary
// EYEPATCH_HOME, and serves test pages on 127.0.0.1:8123.
// Run with: npm run test:e2e (needs Playwright and its Chromium, and ports
// 7457 and 8123 free).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  console.error("Playwright isn't installed (npm i -g playwright && npx playwright install chromium).");
  process.exit(1);
}

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.resolve(BRIDGE_DIR, "../extension");
const HERE = fs.mkdtempSync(path.join(os.tmpdir(), "eyepatch-e2e-"));
const HOME = path.join(HERE, "home");
const MODS = path.join(HOME, "mods");
fs.mkdirSync(path.join(MODS, "old-mod"), { recursive: true });
// An old-format mod, to be converted on startup.
fs.writeFileSync(path.join(MODS, "old-mod/mod.json"), JSON.stringify({ name: "Old", matches: ["http://127.0.0.1/*"] }));
fs.writeFileSync(path.join(MODS, "old-mod/mod.css"), "#old { text-decoration: underline; }");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures++;
};

// ---- test pages ----
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/page.html") {
    res.setHeader("content-type", "text/html");
    return res.end(`<!doctype html><title>t</title><script>window.appState = 7</script><h1 id="t">Hello</h1><p id="old">old</p><div id="out">out</div>`);
  }
  if (u.pathname === "/lib.js") return res.end("var LIB = 42;");
  if (u.pathname === "/note.txt") return res.end("a note");
  if (u.pathname === "/inst.user.js") {
    res.setHeader("content-type", "text/javascript");
    return res.end(`// ==UserScript==\n// @name Installed from web\n// @match http://127.0.0.1/*\n// @grant none\n// ==/UserScript==\ndocument.documentElement.dataset.installed = "yes";\n`);
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(8123, "127.0.0.1", r));

// ---- Agent Bridge ----
const bridge = spawn("npx", ["tsx", "src/index.ts"], { cwd: BRIDGE_DIR, env: { ...process.env, EYEPATCH_HOME: HOME }, detached: true });
let bridgeLog = "";
bridge.stdout.on("data", (d) => (bridgeLog += d));
bridge.stderr.on("data", (d) => (bridgeLog += d));
for (let i = 0; i < 100 && !bridgeLog.includes("websocket"); i++) await new Promise((r) => setTimeout(r, 200));

const write = (name, content) => fs.writeFileSync(path.join(MODS, name), content);
write("red.user.css", `/* ==UserStyle==\n@name Red heading\n@version 1\n==/UserStyle== */\n@-moz-document domain("127.0.0.1") {\n  h1 { color: rgb(255, 0, 0); }\n}\n`);
write("gm.user.js", `// ==UserScript==
// @name GM test
// @match http://127.0.0.1/*
// @require http://127.0.0.1:8123/lib.js
// @resource note http://127.0.0.1:8123/note.txt
// @grant GM_addStyle
// @grant GM_getResourceText
// @grant GM.getResourceUrl
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_registerMenuCommand
// @grant GM_download
// @grant GM.download
// @noframes
// ==/UserScript==
const d = document.documentElement.dataset;
d.lib = typeof LIB !== "undefined" ? LIB : "none";
d.info = GM_info.script.name;
d.page = typeof window.appState;
d.note = GM_getResourceText("note");
GM.getResourceUrl("note").then((u) => (d.noteUrl = u.slice(0, 5)));
try { GM_download("x"); } catch (e) { d.stub = e.message; }
GM.download("x").catch((e) => (d.asyncStub = e.message));
d.count = GM_getValue("count", 0) + 1;
GM_setValue("count", Number(d.count));
GM_registerMenuCommand("Mark it", () => (d.menu = "clicked"));
GM_addStyle("#out { color: rgb(0, 128, 0); }");
globalThis.secret = "gm's";
`);
write("page.user.js", `// ==UserScript==\n// @name Page world\n// @match http://127.0.0.1/*\n// @grant none\n// ==/UserScript==\ndocument.documentElement.dataset.app = window.appState;\nwindow.fromMod = "hi";\n`);
// Another isolated script: it must not see gm.user.js's globals.
write("peek.user.js", `// ==UserScript==\n// @name Peek\n// @match http://127.0.0.1/*\n// @inject-into content\n// @run-at document-idle\n// ==/UserScript==\nsetTimeout(() => (document.documentElement.dataset.peek = typeof globalThis.secret), 200);\n`);
write("filtered.user.js", `// ==UserScript==\n// @name Filtered\n// @include /127\\.0\\.0\\.1:8123\\/page\\.html\\?yes/\n// @inject-into content\n// ==/UserScript==\ndocument.documentElement.dataset.filtered = "yes";\n`);

// ---- browser ----
const ctx = await chromium.launchPersistentContext(path.join(HERE, "profile"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page0 = ctx.pages()[0] ?? (await ctx.newPage());
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = sw.url().split("/")[2];
await page0.goto(`chrome://extensions/?id=${id}`);
await page0.locator("#allow-user-scripts cr-toggle").click();
await page0.waitForTimeout(500);
// The extension may reload itself; find the current worker.
const worker = () => ctx.serviceWorkers().find((w) => w.url().includes(id));
const userScripts = await worker().evaluate(() => { try { chrome.userScripts.getScripts(); return true; } catch { return false; } });
check("user scripts allowed", userScripts);

// Wait until the mods are registered.
const registered = async (n) => {
  for (let i = 0; i < 60; i++) {
    const ids = await worker().evaluate(() => chrome.userScripts.getScripts().then((s) => s.map((x) => x.id))).catch(() => []);
    if (ids.length >= n) return ids;
    await new Promise((r) => setTimeout(r, 250));
  }
  return [];
};
const ids = await registered(12);
check("mods registered", ids.length === 12, JSON.stringify(ids));
check("old mod converted", fs.existsSync(path.join(MODS, "old-mod.user.css")) && !fs.existsSync(path.join(MODS, "old-mod")), fs.readdirSync(MODS).join(","));

const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://127.0.0.1:8123/page.html");
const ds = (k) => page.evaluate((k) => document.documentElement.dataset[k], k);
const waitDs = async (k, ms = 5000) => {
  for (let t = 0; t < ms; t += 100) {
    const v = await ds(k);
    if (v !== undefined) return v;
    await page.waitForTimeout(100);
  }
};
const color = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).color, sel);

check("UserCSS applies", (await color("h1")) === "rgb(255, 0, 0)", await color("h1"));
check("converted old CSS mod applies", (await page.evaluate(() => getComputedStyle(document.querySelector("#old")).textDecorationLine)) === "underline");
check("@require", (await waitDs("lib")) === "42", await ds("lib"));
check("GM_info", (await ds("info")) === "GM test");
check("isolated world can't see page globals", (await ds("page")) === "undefined", await ds("page"));
check("GM_getResourceText", (await ds("note")) === "a note", await ds("note"));
check("GM.getResourceUrl", (await waitDs("noteUrl")) === "data:", await ds("noteUrl"));
check("unsupported grant stub", /GM_download isn't supported/.test((await ds("stub")) ?? ""), await ds("stub"));
check("unsupported GM.* stub rejects", /GM\.download isn't supported/.test((await waitDs("asyncStub")) ?? ""), await ds("asyncStub"));
check("GM storage", (await ds("count")) === "1", await ds("count"));
check("GM_addStyle", (await color("#out")) === "rgb(0, 128, 0)", await color("#out"));
check("@grant none runs in the page", (await ds("app")) === "7" && (await page.evaluate(() => window.fromMod)) === "hi", await ds("app"));
check("isolated scripts can't see each other's globals", (await waitDs("peek")) === "undefined", await ds("peek"));
const gmWorld = await worker().evaluate(() => chrome.userScripts.getScripts({ ids: ["mod:gm.user.js:js"] }).then((s) => s[0]?.worldId));
check("each isolated script has its own world", gmWorld === "mod:gm.user.js", gmWorld);
check("@include regex filter excludes", (await ds("filtered")) === undefined);

await page.goto("http://127.0.0.1:8123/page.html?yes");
check("@include regex filter includes", (await waitDs("filtered")) === "yes");
await page.goto("http://127.0.0.1:8123/page.html");
check("GM storage persists across loads", (await waitDs("count")) === "3", await ds("count"));

// Toolbar badge counts the mods running here.
const tabId = await worker().evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }).then((t) => t[0].id));
await page.waitForTimeout(500);
const badge = await worker().evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId);
check("badge counts running mods", badge === "5", badge);

// Hot swap: edit the style; the page doesn't reload.
await page.evaluate(() => (window.marker = 1));
write("red.user.css", fs.readFileSync(path.join(MODS, "red.user.css"), "utf8").replace("rgb(255, 0, 0)", "rgb(0, 0, 255)"));
for (let i = 0; i < 40 && (await color("h1")) !== "rgb(0, 0, 255)"; i++) await page.waitForTimeout(100);
check("style hot-swaps", (await color("h1")) === "rgb(0, 0, 255)", await color("h1"));
check("…without a reload", (await page.evaluate(() => window.marker)) === 1);

// Side panel: opening it starts console capture, in each script's world too.
const panel = await ctx.newPage();
await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${tabId}`);
await panel.waitForTimeout(800);
const captured = await worker().evaluate(async (t) => {
  const inGm = (code) => chrome.userScripts.execute({ target: { tabId: t }, js: [{ code }], world: "USER_SCRIPT", worldId: "mod:gm.user.js" }).then((r) => r[0]?.result);
  await inGm(`console.log("from gm")`);
  return inGm(`(globalThis.__smConsole ?? []).map((e) => e.mod + ": " + e.text).join()`);
}, tabId);
check("console capture in a script's world", captured === "gm.user.js: from gm", captured);
await panel.locator("#more").click();
const cmd = panel.locator("[data-command]", { hasText: "Mark it" });
check("menu command in side panel", (await cmd.count()) === 1, await panel.locator("#more-menu").innerText().catch(() => ""));
if (await cmd.count()) {
  await cmd.click();
  check("menu command runs", (await waitDs("menu")) === "clicked", await ds("menu"));
}
await panel.locator("#more").click();
await panel.locator('[data-mod="red.user.css"]').click();
for (let i = 0; i < 40 && (await color("h1")) === "rgb(0, 0, 255)"; i++) await page.waitForTimeout(100);
check("turning a style off removes it", (await color("h1")) === "rgb(0, 0, 0)", await color("h1"));
check("…without a reload", (await page.evaluate(() => window.marker)) === 1);
check("off state stored outside the file", JSON.parse(fs.readFileSync(path.join(HOME, "mods-state.json"), "utf8")).disabled.includes("red.user.css"));

// Installing from a .user.js URL: Chrome would download it; Eyepatch opens Settings instead.
const raw = await ctx.newPage();
await raw.goto("http://127.0.0.1:8123/inst.user.js?v=1&x=2").catch(() => {});
for (let i = 0; i < 30 && !raw.url().includes("options.html?install="); i++) await raw.waitForTimeout(100);
const opts = raw.url().includes("options.html?install=") ? raw : null;
check("opening a .user.js URL offers to install", Boolean(opts), raw.url());
if (opts) {
  await opts.locator('#install-body [data-do="install"]').waitFor({ timeout: 5000 });
  await opts.locator('#install-body [data-do="install"]').click({ timeout: 5000 });
  for (let i = 0; i < 30 && !fs.existsSync(path.join(MODS, "inst.user.js")); i++) await opts.waitForTimeout(100);
  check("installed into the mods dir", fs.existsSync(path.join(MODS, "inst.user.js")));
  await page.waitForTimeout(800);
  await page.reload();
  check("installed script runs", (await waitDs("installed")) === "yes");
  // Settings lists every mod, grouped by site.
  await opts.waitForTimeout(300);
  const listed = await opts.locator("#mods .row .name").allInnerTexts();
  check("Settings lists the mods", listed.length === 7, JSON.stringify(listed));
}

if (opts) {
  // Export downloads the file as is.
  const dl = opts.waitForEvent("download");
  await opts.locator('[data-mod="gm.user.js"] [data-do="export"]').click();
  const file = await dl.then((d) => d.path().then((p) => [d.suggestedFilename(), fs.readFileSync(p, "utf8")])).catch((e) => [String(e), ""]);
  check("export", file[0] === "gm.user.js" && file[1] === fs.readFileSync(path.join(MODS, "gm.user.js"), "utf8"), file[0]);
  // Import from files.
  fs.writeFileSync(path.join(HERE, "Some Style.user.css"), `/* ==UserStyle==\n@name Imported\n==/UserStyle== */\n@-moz-document domain("x.com") { a {} }`);
  fs.writeFileSync(path.join(HERE, "junk.js"), "alert(1)");
  await opts.locator("#import-file").setInputFiles([path.join(HERE, "Some Style.user.css"), path.join(HERE, "junk.js")]);
  for (let i = 0; i < 30 && !fs.existsSync(path.join(MODS, "some-style.user.css")); i++) await opts.waitForTimeout(100);
  check("import from file", fs.existsSync(path.join(MODS, "some-style.user.css")), fs.readdirSync(MODS).join(","));
  await opts.waitForTimeout(300);
  check("import rejects non-userscripts", /Couldn’t import junk\.js/.test(await opts.locator("#mods-status").innerText()), await opts.locator("#mods-status").innerText());
}

// A script change reloads the tab (by hand: every matching tab).
await page.evaluate(() => (window.marker = 2));
write("page.user.js", fs.readFileSync(path.join(MODS, "page.user.js"), "utf8").replace('window.fromMod = "hi"', 'window.fromMod = "changed"'));
let changedVal;
for (let i = 0; i < 50; i++) {
  changedVal = await page.evaluate(() => window.fromMod).catch(() => null);
  if (changedVal === "changed") break;
  await new Promise((r) => setTimeout(r, 100));
}
check("script change reloads the tab", changedVal === "changed" && (await page.evaluate(() => window.marker)) === undefined, changedVal);

// Mods keep running with Agent Bridge stopped and the service worker restarted.
process.kill(-bridge.pid);
await new Promise((r) => setTimeout(r, 500));
const cdp = await ctx.newCDPSession(page);
await cdp.send("ServiceWorker.enable");
await cdp.send("ServiceWorker.stopAllWorkers");
await new Promise((r) => setTimeout(r, 500));
const before = Number(await ds("count"));
await page.reload();
check("scripts run without Agent Bridge, after a worker restart", (await waitDs("lib")) === "42" && (await waitDs("peek")) === "undefined", await ds("lib"));
check("…with their GM storage", Number(await waitDs("count")) === before + 1, `${before} -> ${await ds("count")}`);

check("no console errors from mods", !errors.some((e) => /\[mod /.test(e)), errors.join("\n"));
console.log(failures ? `\n${failures} failed` : "\nall passed");
if (failures) console.log("--- bridge log ---\n" + bridgeLog.slice(-3000));
await ctx.close();
try {
  process.kill(-bridge.pid);
} catch {}
server.close();
fs.rmSync(HERE, { recursive: true, force: true });
process.exit(failures ? 1 : 0);

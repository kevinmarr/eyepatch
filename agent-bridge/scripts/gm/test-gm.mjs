// GM API conformance: runs suite.user.js (and start.user.js) in Eyepatch and
// compares each result with reference.json, recorded from Violentmonkey.
//
//   bun run test:gm                          run in Eyepatch and compare
//   bun run test:gm --reference <dir>        record reference.json from an
//                                            unpacked Violentmonkey (MV3)
//
// Needs Playwright and its Chromium, and port 8124 free
// (EYEPATCH_TEST_EXTENSION runs another copy of the extension; DEBUG=1 logs
// the page's console).
// Differences we chose on purpose are in expected-differences.json.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  console.error("Playwright isn't installed (npm i -g playwright && npx playwright install chromium).");
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(HERE, "../..");
const refIdx = process.argv.indexOf("--reference");
const referenceExt = refIdx > 0 ? path.resolve(process.argv[refIdx + 1]) : null;
const EXT = referenceExt ?? process.env.EYEPATCH_TEST_EXTENSION ?? path.resolve(BRIDGE_DIR, "../extension");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyepatch-gm-"));
const file = (name) => fs.readFileSync(path.join(HERE, name), "utf8");

// ---- test server: 127.0.0.1, other.test and blocked.test all land here ----
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const send = (type, body, status = 200, headers = {}) => {
    res.writeHead(status, { "content-type": type, ...headers });
    res.end(body);
  };
  switch (u.pathname) {
    case "/suite.html":
      return send("text/html", `<!doctype html><title>suite</title><script>window.appState = 7</script><p id="suite-out">out</p>`);
    case "/opened.html":
      return send("text/html", "<title>opened</title>opened");
    case "/note.txt":
      return send("text/plain", "a note");
    case "/suite.user.js":
    case "/start.user.js":
      return send("text/javascript", file(u.pathname.slice(1)));
    case "/bytes":
      return send("application/octet-stream", Buffer.from([0, 1, 2, 255]));
    case "/doc.html":
      return send("text/html", "<!doctype html><h1>Doc</h1>");
    case "/doc.xml":
      return send("text/xml", "<?xml version='1.0'?><list><item>X</item></list>");
    case "/redirect":
      return send("text/plain", "", 302, { location: u.searchParams.get("to") });
    case "/slow":
      return setTimeout(() => send("text/plain", "slow"), 2000);
    case "/set-cookie":
      return send("text/plain", "ok", 200, { "set-cookie": "sid=abc; Path=/" });
    case "/echo": {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () =>
        send("application/json", JSON.stringify({ method: req.method, url: u.pathname + u.search, host: u.host, headers: req.headers, body: Buffer.concat(chunks).toString("latin1") })),
      );
      return;
    }
  }
  send("text/plain", "not found", 404);
});
await new Promise((r) => server.listen(8124, "127.0.0.1", r));

// ---- the userscript manager ----
const home = path.join(TMP, "home");
if (!referenceExt) {
  fs.mkdirSync(path.join(home, "mods"), { recursive: true });
  for (const f of ["suite.user.js", "start.user.js"]) fs.writeFileSync(path.join(home, "mods", f), file(f));
  // Chromium starts Agent Bridge: register it as the test profile's native messaging host.
  const hosts = path.join(TMP, "profile", "NativeMessagingHosts");
  spawnSync("bun", ["src/main.ts", "install", "--dir", hosts], { cwd: BRIDGE_DIR, env: { ...process.env, EYEPATCH_HOME: home }, stdio: "inherit" });
}

const launch = () =>
  chromium.launchPersistentContext(path.join(TMP, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--host-resolver-rules=MAP other.test 127.0.0.1, MAP blocked.test 127.0.0.1"],
  });
let ctx = await launch();
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2];
const setup = ctx.pages()[0] ?? (await ctx.newPage());
await setup.goto(`chrome://extensions/?id=${extId}`);
await setup.locator("#allow-user-scripts cr-toggle").click();
await setup.waitForTimeout(1000);
if (referenceExt) {
  // Violentmonkey only notices user scripts were allowed when it starts.
  await ctx.close();
  ctx = await launch();
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent("serviceworker");
  await new Promise((r) => setTimeout(r, 1500));
  // Open each script's URL and press Install.
  for (const f of ["start.user.js", "suite.user.js"]) {
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:8124/${f}`).catch(() => {});
    let c;
    for (let i = 0; i < 100 && !c; i++) {
      c = ctx.pages().find((x) => x.url().includes("/confirm/"));
      if (!c) await p.waitForTimeout(100);
    }
    if (!c) throw new Error(`Violentmonkey didn't offer to install ${f}`);
    await c.locator("button", { hasText: /^Install$/ }).click();
    await c.waitForTimeout(2500);
    if (!c.isClosed()) await c.close();
    if (!p.isClosed()) await p.close();
  }
} else {
  const worker = () => ctx.serviceWorkers().find((w) => w.url().includes(extId));
  for (let i = 0; i < 80; i++) {
    const n = await worker()?.evaluate(() => chrome.userScripts.getScripts().then((s) => s.length)).catch(() => 0);
    if (n >= 4) break;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---- run ----
const page = await ctx.newPage();
if (process.env.DEBUG) page.on("console", (m) => console.log("page:", m.type(), m.text()));
const ds = (p, k) => p.evaluate((k) => document.documentElement.dataset[k], k).catch(() => undefined);
const waitDs = async (p, k, ms = 30000) => {
  for (let t = 0; t < ms; t += 100) {
    const v = await ds(p, k);
    if (v !== undefined) return v;
    await p.waitForTimeout(100);
  }
};
const opened = ctx.waitForEvent("page", { predicate: (x) => x.url().includes("/opened.html"), timeout: 30000 }).then(() => true, () => false);
await page.goto("http://127.0.0.1:8124/suite.html");
const firstStart = JSON.parse((await ds(page, "start")) ?? "null");
await waitDs(page, "waitingForPeer");
const peer = await ctx.newPage();
await peer.goto("http://127.0.0.1:8124/suite.html?peer");
await waitDs(peer, "peerDone");
const results = JSON.parse((await waitDs(page, "gmSuite")) ?? "{}");
if (process.env.DEBUG) console.log("dataset:", await page.evaluate(() => JSON.stringify(document.documentElement.dataset)));
results["openInTab opens the tab"] = await opened;
await page.reload();
const secondStart = JSON.parse((await waitDs(page, "start", 5000)) ?? "null");
results["document-start: values are ready"] = {
  ran: Boolean(firstStart),
  readyState: secondStart?.readyState,
  sawStoredValue: (secondStart?.count ?? 0) > 0,
};

await ctx.close();
server.close();
fs.rmSync(TMP, { recursive: true, force: true });

// ---- compare ----
const REF = path.join(HERE, "reference.json");
if (referenceExt) {
  const manifest = JSON.parse(fs.readFileSync(path.join(referenceExt, "manifest.json"), "utf8"));
  fs.writeFileSync(REF, JSON.stringify({ recordedFrom: `${manifest.name.startsWith("__MSG") ? "Violentmonkey" : manifest.name} ${manifest.version}`, results }, null, 2) + "\n");
  console.log(`Recorded ${Object.keys(results).length} results in reference.json`);
  process.exit(0);
}
const { recordedFrom, results: expected } = JSON.parse(fs.readFileSync(REF, "utf8"));
const allowed = JSON.parse(fs.readFileSync(path.join(HERE, "expected-differences.json"), "utf8"));
let failures = 0;
for (const name of new Set([...Object.keys(expected), ...Object.keys(results)])) {
  const same = isDeepStrictEqual(results[name], expected[name]);
  const ok = same || (name in allowed && isDeepStrictEqual(results[name], allowed[name].eyepatch));
  if (!ok) failures++;
  const tag = same ? "ok  " : ok ? "diff" : "FAIL";
  console.log(`${tag} ${name}${same ? "" : ok ? ` (${allowed[name].why})` : `\n     ${recordedFrom}: ${JSON.stringify(expected[name])}\n     Eyepatch: ${JSON.stringify(results[name])}`}`);
}
console.log(failures ? `\n${failures} failed` : `\nall match ${recordedFrom} (or differ on purpose)`);
process.exit(failures ? 1 : 0);

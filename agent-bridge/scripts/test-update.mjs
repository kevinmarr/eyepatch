// End-to-end check of Agent Bridge updates in a real browser. Builds this
// computer's Agent Bridge three times, as an older version, as the version
// the extension wants (BRIDGE_VERSION in extension/background.js, served as a
// fake GitHub release on 127.0.0.1) and as a newer one. Then, in Playwright's
// Chromium with the extension loaded:
//   1. the older one is installed: Eyepatch updates it and connects;
//   2. the newer one is installed: Eyepatch refuses it (it can't update
//      itself, being unpacked) and leaves it alone.
// Run with: bun run test:update (needs Playwright and its Chromium).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.resolve(BRIDGE_DIR, "../extension");
const WANTED = /const BRIDGE_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(EXT, "background.js"), "utf8"))[1];
const HERE = fs.mkdtempSync(path.join(os.tmpdir(), "eyepatch-update-"));
const HOME = path.join(HERE, "home");
const APP = path.join(HERE, "app");
const EXE = path.join(APP, "agent-bridge");
const HOSTS = path.join(HERE, "profile", "NativeMessagingHosts");
const TARGET = `${process.platform}-${process.arch}`;
const ASSET = `agent-bridge-${TARGET}.tar.gz`;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures++;
};
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: BRIDGE_DIR, encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout;
};

/** Build Agent Bridge stamped with `version`; returns a copy of the executable. */
function build(version) {
  sh("bun", ["scripts/build.ts", TARGET, "--version", version]);
  const out = path.join(HERE, `build-${version}`);
  fs.mkdirSync(out);
  fs.copyFileSync(path.join(BRIDGE_DIR, "dist", TARGET, "agent-bridge"), path.join(out, "agent-bridge"));
  fs.chmodSync(path.join(out, "agent-bridge"), 0o755);
  return path.join(out, "agent-bridge");
}

const older = build("0.0.1");
const wanted = build(WANTED);
const newer = build("99.0.0");

// The fake release: /v<WANTED>/<asset> and its SHA256SUMS.
const release = path.join(HERE, "release");
fs.mkdirSync(release);
sh("tar", ["-czf", path.join(release, ASSET), "-C", path.dirname(wanted), "agent-bridge"]);
const sum = new Bun.CryptoHasher("sha256").update(fs.readFileSync(path.join(release, ASSET))).digest("hex");
fs.writeFileSync(path.join(release, "SHA256SUMS"), `${sum}  ${ASSET}\n`);
const server = http.createServer((req, res) => {
  const m = /^\/v([^/]+)\/([^/]+)$/.exec(req.url);
  if (m && m[1] === WANTED && fs.existsSync(path.join(release, m[2]))) return res.end(fs.readFileSync(path.join(release, m[2])));
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const env = { ...process.env, EYEPATCH_HOME: HOME, EYEPATCH_RELEASES_URL: `http://127.0.0.1:${server.address().port}` };
const version = () => sh(EXE, ["version"]).trim();

/** Install `exe` as the Agent Bridge Chrome runs. */
function install(exe) {
  fs.mkdirSync(APP, { recursive: true });
  fs.copyFileSync(exe, EXE);
  fs.chmodSync(EXE, 0o755);
  sh(EXE, ["install", "--dir", HOSTS], { env });
}

/** Open Settings in a fresh browser and wait until its first setup step says `text`. */
async function settingsShows(text) {
  const ctx = await chromium.launchPersistentContext(path.join(HERE, "profile"), {
    channel: "chromium",
    headless: true,
    env,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${sw.url().split("/")[2]}/options.html`);
    const step = page.locator("#steps li:first-child, #setup-done li:first-child").filter({ hasText: text });
    await step.first().waitFor({ timeout: 60_000 }).catch(() => {});
    return { found: (await step.count()) > 0, shown: await page.locator("#setup, #setup-done").first().innerText().catch(() => "") };
  } finally {
    await ctx.close();
  }
}

try {
  install(older);
  let r = await settingsShows("Agent Bridge running");
  check(`an older Agent Bridge updates itself to ${WANTED} and connects`, r.found, r.shown);
  check("the installed executable is the new version", version() === WANTED, version());

  install(newer);
  r = await settingsShows("needs a newer Eyepatch");
  check("a newer Agent Bridge is refused", r.found, r.shown);
  check("…and left alone", version() === "99.0.0", version());

  const log = fs.readFileSync(path.join(HOME, "logs", "agent-bridge.log"), "utf8");
  check("Agent Bridge logged the update", log.includes(`[update] installed ${WANTED}`), log.slice(-1500));
} finally {
  server.close();
  fs.rmSync(HERE, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HOME, MODS_DIR } from "./config.js";

/**
 * Which coding agent Eyepatch runs, and getting a copy of it.
 *
 * Like Zed, we use the ACP registry (https://agentclientprotocol.com) as the
 * catalog and install a managed copy of the chosen agent under
 * ~/.eyepatch/agents/<id>/<version>. Registry entries are either a
 * per-platform archive (downloaded and checked against its sha256) or an npm
 * package (installed with the npm that came with Agent Bridge's Node).
 * When the registry lists a newer version, it's installed in the background
 * and used the next time the agent starts.
 *
 * EYEPATCH_AGENT="cmd args..." overrides all of this with a custom command.
 */

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const AGENTS_DIR = path.join(HOME, "agents");
const REGISTRY_CACHE = path.join(HOME, "registry.json");
const SETTINGS_FILE = path.join(HOME, "settings.json");
const INSTALL_INFO = ".eyepatch-install.json";

/** Shown first in the picker; the rest are under "More agents". */
/**
 * Registry entries that aren't coding agents you can chat with, or are
 * retired. Hidden from the list (reviewed against the registry, Nov 2026).
 */
const NOT_OFFERED: Record<string, string> = {
  "agoragentic-acp": "an agent marketplace, not a coding agent",
  harn: "a language for writing agent pipelines, not a coding agent",
  kimi: "archived by Moonshot AI in favor of Kimi Code",
};

const FEATURED = ["claude-acp", "codex-acp", "gemini", "github-copilot-cli", "cursor", "opencode"];

/** Id used for the agent given by EYEPATCH_AGENT. */
export const CUSTOM = "custom";

export type LaunchSpec = { cmd: string; args: string[]; env: Record<string, string> };

type BinaryTarget = { archive: string; cmd: string; args?: string[]; env?: Record<string, string>; sha256?: string };
type NpxDist = { package: string; args?: string[]; env?: Record<string, string> };
type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  website?: string;
  repository?: string;
  distribution: { binary?: Record<string, BinaryTarget>; npx?: NpxDist; uvx?: unknown };
};

type InstallInfo = { id: string; version: string; launch: LaunchSpec };

type InstallProgress = {
  id: string;
  name: string;
  version: string;
  update: boolean;
  phase: "downloading" | "verifying" | "extracting" | "npm" | "checking";
  received: number;
  total: number | null;
  detail: string;
};

/** The registry's name for this OS/CPU, e.g. darwin-aarch64. */
const platformKey = (() => {
  let key: string | null | undefined;
  return () => (key === undefined ? (key = detectPlatform()) : key);
})();

function detectPlatform() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch as string];
  if (!os || !arch) return null;
  // getReport() is slow (it builds a full diagnostic report), hence the cache.
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  const musl = os === "linux" && !header?.glibcVersionRuntime;
  return `${os}-${arch}${musl ? "-musl" : ""}`;
}

function howToInstall(agent: RegistryAgent): { binary: BinaryTarget } | { npx: NpxDist } | { reason: string } {
  const key = platformKey();
  const binary = key ? agent.distribution.binary?.[key] : undefined;
  if (binary) return { binary };
  if (agent.distribution.npx) return { npx: agent.distribution.npx };
  if (agent.distribution.uvx) return { reason: "Needs Python (uv), which Eyepatch doesn't install yet" };
  return { reason: "Not available for this computer" };
}

function npmPath() {
  const bundled = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return existsSync(bundled) ? bundled : "npm";
}

function run(cmd: string, args: string[], opts: { cwd?: string; onOutput?: (line: string) => void } = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let tail = "";
    const onData = (d: Buffer) => {
      tail = (tail + String(d)).slice(-2000);
      const line = String(d).trim().split("\n").pop();
      if (line) opts.onOutput?.(line);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}: ${tail.trim().split("\n").slice(-3).join(" ")}`)),
    );
  });
}

function versionDir(id: string, version: string) {
  // Registry ids and versions are plain names, but don't trust them as paths.
  const safe = (s: string) => s.replace(/[^\w.+-]/g, "_");
  return path.join(AGENTS_DIR, safe(id), safe(version));
}

/** npm's "bin" for a package: the one named after it, or its only one. */
async function npmBin(dir: string, pkgSpec: string): Promise<string> {
  const name = pkgSpec.replace(/(.)@[^@/]*$/, "$1");
  const pkgDir = path.join(dir, "node_modules", name);
  const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
  const bins: Record<string, string> = typeof pkg.bin === "string" ? { [name.split("/").pop()!]: pkg.bin } : pkg.bin ?? {};
  const entries = Object.entries(bins);
  if (!entries.length) throw new Error(`${name} has no command to run`);
  const unscoped = name.split("/").pop()!;
  const [, rel] = entries.find(([k]) => k === unscoped) ?? entries[0];
  return path.join(pkgDir, rel);
}

/**
 * Placeholders in a saved launch command, filled in at launch: Agent Bridge's
 * own Node (its path changes with Node upgrades, e.g. nvm) and the agent's
 * install folder (so ~/.eyepatch can move).
 */
const NODE = "$NODE";
const DIR = "$DIR";

/** Run JS bins with Agent Bridge's own Node, so the user doesn't need node on PATH. */
async function launchForScript(file: string, args: string[], env: Record<string, string>): Promise<LaunchSpec> {
  const head = await fs.readFile(file, "utf8").then((s) => s.slice(0, 200)).catch(() => "");
  const isNode = /\.[cm]?js$/.test(file) || /^#!.*\bnode\b/.test(head);
  return isNode ? { cmd: NODE, args: [file, ...args], env } : { cmd: file, args, env };
}

/** Fill in the $NODE and $DIR placeholders of a stored launch command. */
function resolveLaunch(launch: LaunchSpec, dir: string): LaunchSpec {
  const fill = (s: string) => (s === NODE ? process.execPath : s.startsWith(DIR) ? dir + s.slice(DIR.length) : s);
  return { cmd: fill(launch.cmd), args: launch.args.map(fill), env: launch.env };
}

/**
 * Start the agent and ask it for a conversation (ACP initialize, then
 * session/new). Returns why it can't chat, or null if it can or the check was
 * inconclusive (e.g. it needs signing in first, or is slow to start).
 */
function checkCanChat(spec: LaunchSpec): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(spec.cmd, spec.args, { cwd: MODS_DIR, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...spec.env } });
    let settled = false;
    const done = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => done(null), 60_000);
    child.on("error", () => done(null));
    child.on("exit", () => done(null));
    const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    const NOT_FOUND = -32601;
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let msg: { id?: number; error?: { code?: number } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error?.code === NOT_FOUND) return done("doesn't speak ACP");
          if (msg.error) return done(null);
          send({ id: 2, method: "session/new", params: { cwd: MODS_DIR, mcpServers: [] } });
        } else if (msg.id === 2) {
          return done(msg.error?.code === NOT_FOUND ? "can't start a conversation" : null);
        }
      }
    });
    child.stdin.on("error", () => {});
    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    });
  });
}

/** The agent settings a chat can pick, remembered per agent. */
export type SelectKind = "model" | "effort" | "mode";

export class AgentManager {
  private registry: RegistryAgent[] = [];
  private registryError: string | null = null;
  private settings: { agent?: string; models?: Record<string, string>; efforts?: Record<string, string>; modes?: Record<string, string> } = {};
  private installed = new Map<string, InstallInfo>(); // id -> newest installed copy
  private installing: InstallProgress | null = null;
  private installError: { id: string; message: string } | null = null;
  private readonly custom = process.env.EYEPATCH_AGENT?.trim() || null;
  private updateListeners: Array<(id: string) => void> = [];

  constructor(private readonly send: (msg: Record<string, unknown>) => void) {}

  async init() {
    await fs.mkdir(AGENTS_DIR, { recursive: true });
    this.settings = await fs
      .readFile(SETTINGS_FILE, "utf8")
      .then((s) => JSON.parse(s))
      .catch(() => ({}));
    this.registry = await fs
      .readFile(REGISTRY_CACHE, "utf8")
      .then((s) => JSON.parse(s).agents ?? [])
      .catch(() => []);
    await this.scanInstalled();
    // Fetch a fresh catalog in the background; it may bring updates.
    void this.refresh();
  }

  /** A newer copy of an installed agent is ready; it's used the next time that agent starts. */
  onUpdated(listener: (id: string) => void) {
    this.updateListeners.push(listener);
  }

  /** The agent new tabs start with: the one picked most recently. */
  get defaultId(): string | null {
    if (this.custom) return CUSTOM;
    // A chosen agent whose copy is gone (e.g. its folder was deleted) has to be picked again.
    const id = this.settings.agent;
    return id && this.installed.has(id) ? id : null;
  }

  installedIds(): string[] {
    return this.custom ? [CUSTOM] : [...this.installed.keys()];
  }

  /** Delete an agent's copy. New tabs fall back to another installed agent. */
  async remove(id: string) {
    if (this.custom || this.installing?.id === id || !this.installed.has(id)) return;
    this.installed.delete(id);
    if (this.installError?.id === id) this.installError = null;
    if (this.settings.agent === id) {
      this.settings.agent = [...this.installed.keys()][0];
      await this.saveSettings();
    }
    this.sendView();
    await fs.rm(path.join(AGENTS_DIR, id), { recursive: true, force: true }).catch((e) => console.warn(`[agents] removing ${id}:`, e));
  }

  isInstalled(id: string) {
    return id === CUSTOM ? Boolean(this.custom) : this.installed.has(id);
  }

  /** How to start an agent, or undefined if it isn't installed. */
  launchSpec(id: string): LaunchSpec | undefined {
    if (this.custom) {
      const [cmd, ...args] = this.custom.split(/\s+/);
      return { cmd, args, env: {} };
    }
    const info = this.installed.get(id);
    return info && resolveLaunch(info.launch, versionDir(id, info.version));
  }

  /** Display name from the registry. */
  nameOf(id: string) {
    return this.registry.find((a) => a.id === id)?.name ?? id;
  }

  /** The model, effort level or mode last picked for an agent. */
  preferred(kind: SelectKind, id: string): string | undefined {
    return this.settings[`${kind}s`]?.[id];
  }

  async setPreferred(kind: SelectKind, id: string, value: string) {
    const key = `${kind}s` as const;
    this.settings[key] = { ...this.settings[key], [id]: value };
    await this.saveSettings();
  }

  private saveSettings() {
    return fs.writeFile(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
  }

  /** Delete copies of an agent other than the one we launch. */
  async pruneOldVersions(id: string) {
    const keep = this.installed.get(id);
    if (!keep || this.installing?.id === id) return; // don't delete an install in progress
    const dir = path.dirname(versionDir(id, keep.version));
    for (const v of await fs.readdir(dir).catch(() => [])) {
      if (path.join(dir, v) !== versionDir(id, keep.version)) {
        await fs.rm(path.join(dir, v), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async refresh() {
    try {
      const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body?.agents)) throw new Error("unexpected format");
      this.registry = body.agents;
      this.registryError = null;
      await fs.writeFile(REGISTRY_CACHE, JSON.stringify(body));
    } catch (e) {
      this.registryError = `Couldn't load the agent list: ${(e as Error).message}`;
      console.warn("[agents]", this.registryError);
    }
    this.sendView();
    void this.updateInstalled();
  }

  /** Install the registry's newer versions of installed agents, one at a time. */
  private async updateInstalled() {
    if (this.custom) return;
    for (const [id, current] of [...this.installed]) {
      const latest = this.registry.find((a) => a.id === id);
      if (!latest || latest.version === current.version || this.installing) continue;
      console.log(`[agents] updating ${id} ${current.version} → ${latest.version}`);
      try {
        await this.install(latest, true);
        for (const l of this.updateListeners) l(id);
      } catch (e) {
        console.warn(`[agents] update of ${id} failed:`, (e as Error).message);
      }
    }
  }

  /**
   * Make sure an agent is installed (installing it if needed) and make it the
   * default for new tabs. Returns false if it couldn't be installed.
   */
  async choose(id: string): Promise<boolean> {
    if (this.custom) return id === CUSTOM;
    if (this.installing) return false;
    this.installError = null;
    const agent = this.registry.find((a) => a.id === id);
    if (!this.installed.has(id)) {
      if (NOT_OFFERED[id]) {
        this.failInstall(id, `It's ${NOT_OFFERED[id]}`);
        return false;
      }
      if (!agent) {
        this.failInstall(id, "That agent isn't in the registry");
        return false;
      }
      try {
        await this.install(agent, false);
      } catch (e) {
        this.failInstall(id, (e as Error).message);
        return false;
      }
    }
    this.settings.agent = id;
    await this.saveSettings();
    this.sendView();
    return true;
  }

  private failInstall(id: string, message: string) {
    console.warn(`[agents] install of ${id} failed:`, message);
    this.installError = { id, message };
    this.sendView();
  }

  private async scanInstalled() {
    this.installed.clear();
    for (const id of await fs.readdir(AGENTS_DIR).catch(() => [])) {
      for (const v of await fs.readdir(path.join(AGENTS_DIR, id)).catch(() => [])) {
        try {
          const info: InstallInfo = JSON.parse(await fs.readFile(path.join(AGENTS_DIR, id, v, INSTALL_INFO), "utf8"));
          const prev = this.installed.get(info.id);
          // Prefer the copy matching the registry, else whichever was installed last.
          if (!prev || this.registry.find((a) => a.id === info.id)?.version === info.version) {
            this.installed.set(info.id, info);
          }
        } catch {
          // Not a finished install (e.g. interrupted); ignore.
        }
      }
    }
  }

  private async install(agent: RegistryAgent, update: boolean) {
    const how = howToInstall(agent);
    if ("reason" in how) throw new Error(how.reason);
    const dest = versionDir(agent.id, agent.version);
    const tmp = `${dest}.partial`;
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(tmp, { recursive: true });
    this.installing = {
      id: agent.id,
      name: agent.name,
      version: agent.version,
      update,
      phase: "binary" in how ? "downloading" : "npm",
      received: 0,
      total: null,
      detail: "",
    };
    this.sendView();
    try {
      const launch = "binary" in how ? await this.installBinary(how.binary, tmp) : await this.installNpm(how.npx, tmp);
      const info: InstallInfo = { id: agent.id, version: agent.version, launch };
      if (!update) {
        // Some registry entries speak ACP but can't hold a conversation (e.g.
        // marketplaces or tool servers). Find out before calling it installed.
        this.progress({ phase: "checking" });
        const problem = await checkCanChat(resolveLaunch(launch, tmp));
        if (problem) throw new Error(`${agent.name} ${problem}, so it can't be used with Eyepatch`);
      }
      await fs.writeFile(path.join(tmp, INSTALL_INFO), JSON.stringify(info, null, 2));
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(tmp, dest);
      this.installed.set(agent.id, info);
      console.log(`[agents] installed ${agent.id} ${agent.version}`);
    } catch (e) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      await fs.rmdir(path.dirname(dest)).catch(() => {}); // only if nothing else is installed there
      throw e;
    } finally {
      this.installing = null;
      this.sendView();
    }
  }

  private progress(patch: Partial<InstallProgress>, throttle = false) {
    if (!this.installing) return;
    Object.assign(this.installing, patch);
    const now = Date.now();
    if (throttle && now - this.lastProgress < 250) return;
    this.lastProgress = now;
    this.sendView();
  }
  private lastProgress = 0;

  private async installBinary(target: BinaryTarget, tmp: string): Promise<LaunchSpec> {
    const url = new URL(target.archive);
    if (url.protocol !== "https:") throw new Error("Refusing to download over plain HTTP");
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length")) || null;
    const name = path.basename(url.pathname);
    const archiveKind = /\.zip$/i.test(name)
      ? "zip"
      : /\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(name)
        ? "tar"
        : "raw"; // a bare executable
    const file = path.join(tmp, archiveKind === "raw" ? path.basename(target.cmd) : `download-${name}`);
    const hash = createHash("sha256");
    let received = 0;
    this.progress({ total });
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          hash.update(chunk);
          received += chunk.length;
          this.progress({ received }, true);
          cb(null, chunk);
        },
      }),
      createWriteStream(file),
    );
    this.progress({ phase: "verifying", received });
    if (target.sha256 && hash.digest("hex") !== target.sha256.toLowerCase()) {
      throw new Error("The download didn't match the registry's checksum");
    }
    if (archiveKind !== "raw") {
      this.progress({ phase: "extracting" });
      // bsdtar (macOS, Windows) reads zip too; GNU tar on Linux doesn't.
      if (archiveKind === "zip" && process.platform === "linux") await run("unzip", ["-q", "-o", file, "-d", tmp]);
      else await run("tar", ["-xf", file, "-C", tmp]);
      await fs.rm(file);
    }
    const cmd = path.resolve(tmp, target.cmd);
    if (!cmd.startsWith(tmp + path.sep)) throw new Error("The agent's command points outside its folder");
    await fs.chmod(cmd, 0o755).catch(() => {});
    return { cmd: DIR + cmd.slice(tmp.length), args: target.args ?? [], env: target.env ?? {} };
  }

  private async installNpm(npx: NpxDist, tmp: string): Promise<LaunchSpec> {
    await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ private: true }));
    await run(npmPath(), ["install", "--no-audit", "--no-fund", "--omit=dev", npx.package], {
      cwd: tmp,
      onOutput: (line) => this.progress({ detail: line.slice(0, 200) }, true),
    });
    const bin = await npmBin(tmp, npx.package);
    const spec = await launchForScript(bin, npx.args ?? [], npx.env ?? {});
    const rel = (p: string) => (p.startsWith(tmp + path.sep) ? DIR + p.slice(tmp.length) : p);
    return { ...spec, cmd: rel(spec.cmd), args: spec.args.map(rel) };
  }

  view() {
    const card = (a: RegistryAgent) => {
      const how = howToInstall(a);
      const inst = this.installed.get(a.id);
      return {
        id: a.id,
        name: a.name,
        description: a.description ?? null,
        icon: a.icon ?? null,
        website: a.website ?? a.repository ?? null,
        version: a.version,
        installedVersion: inst?.version ?? null,
        kind: "binary" in how ? "download" : "npx" in how ? "npm" : null,
        unavailable: (NOT_OFFERED[a.id] ?? ("reason" in how ? how.reason : null)) as string | null,
      };
    };
    const byFeatured = (a: RegistryAgent) => {
      const i = FEATURED.indexOf(a.id);
      return i < 0 ? FEATURED.length : i;
    };
    const list = [...this.registry]
      .sort((a, b) => byFeatured(a) - byFeatured(b) || a.name.localeCompare(b.name))
      .map((a) => ({ ...card(a), featured: FEATURED.includes(a.id) }));
    // Keep an installed agent pickable even if it left the registry.
    for (const [id, info] of this.installed) {
      if (!list.some((a) => a.id === id)) {
        list.push({ id, name: id, description: null, icon: null, website: null, version: info.version, installedVersion: info.version, kind: null, unavailable: null, featured: false });
      }
    }
    return {
      defaultAgent: this.defaultId,
      custom: this.custom,
      agentsDir: AGENTS_DIR.startsWith(os.homedir() + path.sep) ? "~" + AGENTS_DIR.slice(os.homedir().length) : AGENTS_DIR,
      list,
      installing: this.installing,
      installError: this.installError,
      registryError: this.registry.length ? null : this.registryError,
    };
  }

  sendView() {
    this.send({ type: "agents", agents: this.view() });
  }
}

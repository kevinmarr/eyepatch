import { existsSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HOME, MODS_DIR } from "./config.ts";

/**
 * Which coding agents Eyepatch can run, and getting a copy of them.
 *
 * Like Zed, we use the ACP registry (https://agentclientprotocol.com) as the
 * catalog and install a managed copy of each chosen agent under
 * ~/.eyepatch/agents/<id>/<version>. Registry entries are either a
 * per-platform archive (downloaded and checked against its sha256) or an npm
 * package. npm packages are installed and run with Bun: Agent Bridge's own
 * executable acts as the `bun` command when started with BUN_BE_BUN=1, so
 * nothing else needs installing. When the registry lists a newer version,
 * it's installed in the background and used the next time the agent starts.
 *
 * Several Agent Bridges can share ~/.eyepatch (one per Chrome profile), so
 * installs take a lock, and each process marks the copies it's running so
 * another one's update doesn't delete them.
 *
 * EYEPATCH_AGENT="cmd args..." overrides all of this with a custom command.
 */

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const AGENTS_DIR = path.join(HOME, "agents");
const REGISTRY_CACHE = path.join(HOME, "registry.json");
const SETTINGS_FILE = path.join(HOME, "settings.json");
const INSTALL_INFO = ".eyepatch-install.json";
const LOCK_FILE = path.join(AGENTS_DIR, ".lock");
const BUN_CACHE = path.join(HOME, "cache", "bun");

/**
 * Registry entries we don't offer, and why (reviewed against the registry,
 * Nov 2026). Some aren't agents you can chat with or are retired; the npm
 * ones marked "Bun" were tested and don't run on Bun (they do on Node).
 */
const NOT_OFFERED: Record<string, string> = {
  "agoragentic-acp": "It's an agent marketplace, not a coding agent",
  harn: "It's a language for writing agent pipelines, not a coding agent",
  kimi: "Archived by Moonshot AI in favor of Kimi Code",
  "github-copilot": "Use the other GitHub Copilot entry (this package is broken)",
  "pi-acp": "Needs pi installed separately",
  nova: "Doesn't run on Bun yet",
  qoder: "Doesn't run on Bun yet",
  "minimax-code": "Doesn't run on Bun yet",
};

/** Shown first in the picker; the rest are under "More agents". */
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
  phase: "waiting" | "downloading" | "verifying" | "extracting" | "npm" | "checking";
  received: number;
  total: number | null;
  detail: string;
};

/** The registry's name for this OS/CPU, e.g. darwin-aarch64 or linux-x86_64-musl. */
const PLATFORM = (() => {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch as string];
  if (!os || !arch) return null;
  const musl = os === "linux" && ["/lib/ld-musl-x86_64.so.1", "/lib/ld-musl-aarch64.so.1"].some((f) => existsSync(f));
  return `${os}-${arch}${musl ? "-musl" : ""}`;
})();

function howToInstall(agent: RegistryAgent): { binary: BinaryTarget } | { npx: NpxDist } | { reason: string } {
  const binary = PLATFORM ? agent.distribution.binary?.[PLATFORM] : undefined;
  if (binary) return { binary };
  if (agent.distribution.npx) return { npx: agent.distribution.npx };
  if (agent.distribution.uvx) return { reason: "Needs Python (uv), which Eyepatch doesn't install yet" };
  return { reason: "Not available for this computer" };
}

/** Run Bun (this executable, acting as Bun) with these args. */
const BUN_ENV = { BUN_BE_BUN: "1" };

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; onOutput?: (line: string) => void } = {}) {
  const child = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  let tail = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      tail = (tail + text).slice(-2000);
      const line = text.trim().split("\n").pop();
      if (line) opts.onOutput?.(line);
    }
  };
  await Promise.all([read(child.stdout), read(child.stderr)]);
  const code = await child.exited;
  if (code !== 0) throw new Error(`${path.basename(cmd[0])} exited with ${code}: ${tail.trim().split("\n").slice(-3).join(" ")}`);
}

function versionDir(id: string, version: string) {
  // Registry ids and versions are plain names, but don't trust them as paths.
  const safe = (s: string) => s.replace(/[^\w.+-]/g, "_");
  return path.join(AGENTS_DIR, safe(id), safe(version));
}

/** An npm package's "bin": the one named after it, or its only one. */
async function npmBin(dir: string, pkgSpec: string): Promise<string> {
  const name = pkgSpec.replace(/(.)@[^@/]*$/, "$1");
  const pkgDir = path.join(dir, "node_modules", name);
  const pkg = await Bun.file(path.join(pkgDir, "package.json")).json();
  const bins: Record<string, string> = typeof pkg.bin === "string" ? { [name.split("/").pop()!]: pkg.bin } : (pkg.bin ?? {});
  const entries = Object.entries(bins);
  if (!entries.length) throw new Error(`${name} has no command to run`);
  const unscoped = name.split("/").pop()!;
  const [, rel] = entries.find(([k]) => k === unscoped) ?? entries[0];
  const bin = path.resolve(pkgDir, rel);
  if (!bin.startsWith(dir + path.sep)) throw new Error(`${name}'s command points outside its folder`);
  return bin;
}

/**
 * Placeholders in a saved launch command, filled in at launch: Bun (this
 * executable, whose path changes when it's updated or moved) and the agent's
 * install folder (so ~/.eyepatch can move). $NODE is the older name for $BUN,
 * from installs made when Agent Bridge ran on Node.
 */
const BUN = "$BUN";
const NODE = "$NODE";
const DIR = "$DIR";

/** Run JS bins with Bun, so the user doesn't need Node. */
async function launchForScript(file: string, args: string[], env: Record<string, string>): Promise<LaunchSpec> {
  const head = await Bun.file(file).slice(0, 200).text().catch(() => "");
  const isJs = /\.[cm]?[jt]s$/.test(file) || /^#!.*\b(node|bun)\b/.test(head);
  return isJs ? { cmd: BUN, args: [file, ...args], env } : { cmd: file, args, env };
}

/** Fill in the placeholders of a stored launch command. */
function resolveLaunch(launch: LaunchSpec, dir: string): LaunchSpec {
  const fill = (s: string) => (s === BUN || s === NODE ? process.execPath : s.startsWith(DIR) ? dir + s.slice(DIR.length) : s);
  const viaBun = launch.cmd === BUN || launch.cmd === NODE;
  return { cmd: fill(launch.cmd), args: launch.args.map(fill), env: viaBun ? { ...BUN_ENV, ...launch.env } : launch.env };
}

/**
 * Start the agent and ask it for a conversation (ACP initialize, then
 * session/new). Returns why it can't chat, or null if it can or the check was
 * inconclusive (e.g. it needs signing in first, or is slow to start).
 */
async function checkCanChat(spec: LaunchSpec): Promise<string | null> {
  const child = Bun.spawn([spec.cmd, ...spec.args], {
    cwd: MODS_DIR,
    env: { ...process.env, ...spec.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const send = (m: object) => {
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
      child.stdin.flush();
    } catch {}
  };
  const NOT_FOUND = -32601;
  const answer = (async (): Promise<string | null> => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of child.stdout) {
      buf += decoder.decode(chunk, { stream: true });
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
          if (msg.error?.code === NOT_FOUND) return "doesn't speak ACP";
          if (msg.error) return null;
          send({ id: 2, method: "session/new", params: { cwd: MODS_DIR, mcpServers: [] } });
        } else if (msg.id === 2) {
          return msg.error?.code === NOT_FOUND ? "can't start a conversation" : null;
        }
      }
    }
    return null;
  })();
  send({
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
  });
  const result = await Promise.race([answer, Bun.sleep(60_000).then(() => null)]);
  child.kill();
  return result;
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};

/**
 * Hold the install lock (shared by every Agent Bridge using this
 * ~/.eyepatch) while `work` runs. Returns null without running it if
 * another process holds the lock and `wait` is false.
 */
async function withInstallLock<T>(work: () => Promise<T>, { wait, onWait }: { wait: boolean; onWait?: () => void }): Promise<T | null> {
  for (let waited = false; ; ) {
    try {
      await fs.writeFile(LOCK_FILE, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      const holder = Number(await fs.readFile(LOCK_FILE, "utf8").catch(() => ""));
      if (!holder || !pidAlive(holder)) {
        await fs.rm(LOCK_FILE, { force: true }); // left by a process that died
        continue;
      }
      if (!wait) return null;
      if (!waited) onWait?.();
      waited = true;
      await Bun.sleep(1000);
    }
  }
  try {
    return await work();
  } finally {
    await fs.rm(LOCK_FILE, { force: true });
  }
}

/** Marks an installed copy as running in this process, so no other process prunes it. */
const inUseFile = (dir: string) => path.join(dir, `.in-use-${process.pid}`);

async function inUseByOthers(dir: string) {
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const pid = Number(/^\.in-use-(\d+)$/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    if (pidAlive(pid)) return true;
    await fs.rm(path.join(dir, name), { force: true });
  }
  return false;
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
  private running = new Set<string>(); // version dirs this process marked in use

  constructor(private readonly send: (msg: Record<string, unknown>) => void) {}

  async init() {
    await fs.mkdir(AGENTS_DIR, { recursive: true });
    this.settings = await Bun.file(SETTINGS_FILE)
      .json()
      .catch(() => ({}));
    this.registry = await Bun.file(REGISTRY_CACHE)
      .json()
      .then((r) => r.agents ?? [])
      .catch(() => []);
    await this.scanInstalled();
    process.on("exit", () => {
      for (const dir of this.running) rmSync(inUseFile(dir), { force: true });
    });
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

  /** The agent is starting: mark its copy as in use by this process. */
  async markRunning(id: string) {
    const info = this.installed.get(id);
    if (!info) return;
    const dir = versionDir(id, info.version);
    this.running.add(dir);
    await fs.writeFile(inUseFile(dir), "").catch(() => {});
  }

  /** The agent stopped: its copy can be pruned by whoever updates it. */
  async markStopped(id: string) {
    const info = this.installed.get(id);
    for (const dir of [...this.running]) {
      if (path.dirname(dir) !== path.dirname(versionDir(id, info?.version ?? "x"))) continue;
      this.running.delete(dir);
      await fs.rm(inUseFile(dir), { force: true });
    }
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

  private async saveSettings() {
    await Bun.write(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
  }

  /** Delete copies of an agent other than the one we launch, unless another Agent Bridge is running them. */
  async pruneOldVersions(id: string) {
    const keep = this.installed.get(id);
    if (!keep || this.installing?.id === id) return; // don't delete an install in progress
    const keepDir = versionDir(id, keep.version);
    const dir = path.dirname(keepDir);
    for (const v of await fs.readdir(dir).catch(() => [] as string[])) {
      const old = path.join(dir, v);
      if (old === keepDir || v.endsWith(".partial") || this.running.has(old) || (await inUseByOthers(old))) continue;
      await fs.rm(old, { recursive: true, force: true }).catch(() => {});
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
      await Bun.write(REGISTRY_CACHE, JSON.stringify(body));
    } catch (e) {
      this.registryError = `Couldn't load the agent list: ${(e as Error).message}`;
      console.warn("[agents]", this.registryError);
    }
    // Another Agent Bridge may have installed or updated agents meanwhile.
    await this.scanInstalled();
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
        // If another Agent Bridge is installing, it'll do the update; we pick it up on the next scan.
        const done = await withInstallLock(() => this.install(latest, true), { wait: false });
        if (done === null) continue;
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
        this.failInstall(id, NOT_OFFERED[id]);
        return false;
      }
      if (!agent) {
        this.failInstall(id, "That agent isn't in the registry");
        return false;
      }
      try {
        await withInstallLock(
          async () => {
            await this.scanInstalled(); // another Agent Bridge may have just installed it
            if (!this.installed.has(id)) await this.install(agent, false);
          },
          { wait: true, onWait: () => this.startProgress(agent, false, "waiting") },
        );
      } catch (e) {
        this.failInstall(id, (e as Error).message);
        return false;
      } finally {
        if ((this.installing as InstallProgress | null)?.phase === "waiting") this.installing = null;
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
    const found = new Map<string, InstallInfo>();
    for (const id of await fs.readdir(AGENTS_DIR).catch(() => [] as string[])) {
      for (const v of await fs.readdir(path.join(AGENTS_DIR, id)).catch(() => [] as string[])) {
        try {
          const info: InstallInfo = await Bun.file(path.join(AGENTS_DIR, id, v, INSTALL_INFO)).json();
          const prev = found.get(info.id);
          // Prefer the copy matching the registry, else whichever was installed last.
          if (!prev || this.registry.find((a) => a.id === info.id)?.version === info.version) found.set(info.id, info);
        } catch {
          // Not a finished install (e.g. interrupted); ignore.
        }
      }
    }
    this.installed = found;
  }

  private startProgress(agent: RegistryAgent, update: boolean, phase: InstallProgress["phase"]) {
    this.installing = { id: agent.id, name: agent.name, version: agent.version, update, phase, received: 0, total: null, detail: "" };
    this.sendView();
  }

  private async install(agent: RegistryAgent, update: boolean) {
    const how = howToInstall(agent);
    if ("reason" in how) throw new Error(how.reason);
    const dest = versionDir(agent.id, agent.version);
    const tmp = `${dest}.partial`;
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(tmp, { recursive: true });
    this.startProgress(agent, update, "binary" in how ? "downloading" : "npm");
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
      await Bun.write(path.join(tmp, INSTALL_INFO), JSON.stringify(info, null, 2));
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
    const archiveKind = /\.zip$/i.test(name) ? "zip" : /\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(name) ? "tar" : "raw"; // raw: a bare executable
    const file = path.join(tmp, archiveKind === "raw" ? path.basename(target.cmd) : `download-${name}`);
    const hash = new Bun.CryptoHasher("sha256");
    const out = Bun.file(file).writer();
    let received = 0;
    this.progress({ total });
    for await (const chunk of res.body) {
      hash.update(chunk);
      out.write(chunk);
      received += chunk.length;
      this.progress({ received }, true);
    }
    await out.end();
    this.progress({ phase: "verifying", received });
    if (target.sha256 && hash.digest("hex") !== target.sha256.toLowerCase()) {
      throw new Error("The download didn't match the registry's checksum");
    }
    if (archiveKind !== "raw") {
      this.progress({ phase: "extracting" });
      // bsdtar (macOS, Windows) reads zip too; GNU tar on Linux doesn't.
      if (archiveKind === "zip" && process.platform === "linux") await run(["unzip", "-q", "-o", file, "-d", tmp]);
      else await run(["tar", "-xf", file, "-C", tmp]);
      await fs.rm(file);
    }
    const cmd = path.resolve(tmp, target.cmd);
    if (!cmd.startsWith(tmp + path.sep)) throw new Error("The agent's command points outside its folder");
    await fs.chmod(cmd, 0o755).catch(() => {});
    // Archives sometimes ship a JS entry point rather than a binary.
    const spec = await launchForScript(cmd, target.args ?? [], target.env ?? {});
    const rel = (p: string) => (p.startsWith(tmp + path.sep) ? DIR + p.slice(tmp.length) : p);
    return { ...spec, cmd: rel(spec.cmd), args: spec.args.map(rel) };
  }

  private async installNpm(npx: NpxDist, tmp: string): Promise<LaunchSpec> {
    await Bun.write(path.join(tmp, "package.json"), JSON.stringify({ private: true }));
    // Lifecycle scripts don't run (Bun's default for untrusted packages);
    // every npm agent we offer was tested to work without them.
    await run([process.execPath, "add", "--no-summary", npx.package], {
      cwd: tmp,
      env: { ...BUN_ENV, BUN_INSTALL_CACHE_DIR: BUN_CACHE },
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

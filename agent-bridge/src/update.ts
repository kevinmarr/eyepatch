import fs from "node:fs/promises";
import path from "node:path";
import { COMPILED, TARGET } from "./config.ts";

/**
 * Agent Bridge replacing itself with the release the extension asks for. The
 * extension decides when (see BRIDGE_VERSION in extension/background.js), so
 * Agent Bridge only ever changes when a new extension version arrives.
 *
 * The new executable comes from the GitHub release for that exact version, is
 * checked against the release's SHA256SUMS, must be signed by the same Apple
 * team as this one (macOS, when this one is Developer ID signed), and must
 * say it's that version when run. It then replaces this executable in place;
 * the running process carries on until the extension restarts it.
 */

export const RELEASES = "https://github.com/kevinmarr/eyepatch/releases/download";

export type UpdateOptions = {
  /** Where releases are downloaded from (tests point this, or EYEPATCH_RELEASES_URL, at a local server). */
  releases?: string;
  /** The executable to replace (default: this one). */
  exe?: string;
  /** This build's platform, like darwin-arm64 or linux-x64-musl. */
  target?: string | null;
};

export async function selfUpdate(version: string, opts: UpdateOptions = {}) {
  const exe = opts.exe ?? process.execPath;
  const target = opts.target === undefined ? TARGET : opts.target;
  if (!opts.exe && !COMPILED) throw new Error("Agent Bridge is running from source; update it with git");
  if (!target) throw new Error("This build doesn't know its platform");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version}`);

  const windows = target.startsWith("windows");
  const asset = `agent-bridge-${target}${windows ? ".zip" : ".tar.gz"}`;
  const base = `${opts.releases ?? process.env.EYEPATCH_RELEASES_URL ?? RELEASES}/v${version}`;
  console.log(`[update] downloading ${base}/${asset}`);

  // Next to the executable, so the final rename stays on one filesystem.
  const tmp = await fs.mkdtemp(path.join(path.dirname(exe), ".update-"));
  try {
    const sums = await download(`${base}/SHA256SUMS`);
    const expected = new TextDecoder()
      .decode(sums)
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === asset || name === `*${asset}`)?.[0];
    if (!expected) throw new Error(`${asset} isn't listed in the release's SHA256SUMS`);

    const archive = await download(`${base}/${asset}`);
    const actual = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
    if (actual !== expected.toLowerCase()) throw new Error("The download didn't match the release's checksum");

    const file = path.join(tmp, asset);
    await Bun.write(file, archive);
    // bsdtar (macOS, Windows) reads zip too.
    await run(["tar", "-xf", file, "-C", tmp]);
    const fresh = path.join(tmp, windows ? "agent-bridge.exe" : "agent-bridge");
    await fs.chmod(fresh, 0o755);

    if (process.platform === "darwin") await checkSignature(exe, fresh);
    const reported = (await run([fresh, "version"])).out.trim();
    if (reported !== version) throw new Error(`The download says it's version ${reported || "(nothing)"}, not ${version}`);

    if (windows) {
      // A running .exe can't be replaced, but it can be renamed out of the way.
      await fs.rm(`${exe}.old`, { force: true }).catch(() => {});
      await fs.rename(exe, `${exe}.old`);
    }
    await fs.rename(fresh, exe);
    console.log(`[update] installed ${version}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Remove what an update on Windows left behind (the previous executable). */
export async function cleanUpAfterUpdate() {
  if (COMPILED && process.platform === "win32") await fs.rm(`${process.execPath}.old`, { force: true }).catch(() => {});
}

async function download(url: string): Promise<Uint8Array> {
  if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1")) throw new Error("Refusing to download over plain HTTP");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${url} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * If this executable is signed with a Developer ID, the new one has to be
 * signed by the same team. (An ad-hoc signed build, from before releases were
 * signed, accepts any build that passes the checksum.)
 */
async function checkSignature(current: string, fresh: string) {
  const team = await teamOf(current);
  if (!team) return;
  const requirement = `anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${team}"`;
  try {
    await run(["codesign", "--verify", "--strict", `-R=${requirement}`, fresh]);
  } catch {
    throw new Error(`The download isn't signed by this build's developer (${team})`);
  }
}

async function teamOf(file: string): Promise<string | null> {
  const out = await run(["codesign", "-dv", "--verbose=2", file]).then((r) => r.err, () => ""); // codesign -d writes to stderr
  const team = /^TeamIdentifier=(\w+)$/m.exec(out)?.[1];
  return team && team !== "not" ? team : null;
}

/** Run a command; what it printed, if it succeeded. */
async function run(cmd: string[]): Promise<{ out: string; err: string }> {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${path.basename(cmd[0])} exited with ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`);
  return { out, err };
}

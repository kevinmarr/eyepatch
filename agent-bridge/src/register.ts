import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPILED, EXTENSION_ID, HOME, HOST_NAME } from "./config.ts";

/**
 * Registering Agent Bridge as a native messaging host, so the extension can
 * start it with chrome.runtime.connectNative(). Each Chromium-based browser
 * looks for a small JSON manifest in its own folder (a registry key pointing
 * at one on Windows). It names the program to run and the only extension
 * allowed to run it.
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
 */

/** Per-user config folders of Chromium-based browsers; manifests go in NativeMessagingHosts inside. */
function browserDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return [
      "Google/Chrome",
      "Google/Chrome Beta",
      "Google/Chrome Dev",
      "Google/Chrome Canary",
      "Chromium",
      "BraveSoftware/Brave-Browser",
      "Microsoft Edge",
      "Microsoft Edge Beta",
      "Microsoft Edge Dev",
      "Microsoft Edge Canary",
      "Vivaldi",
      "Arc/User Data",
    ].map((d) => path.join(base, d));
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return [
    "google-chrome",
    "google-chrome-beta",
    "google-chrome-unstable",
    "chromium",
    "BraveSoftware/Brave-Browser",
    "microsoft-edge",
    "microsoft-edge-beta",
    "microsoft-edge-dev",
    "vivaldi",
  ].map((d) => path.join(base, d));
}

/** Windows registry keys (under HKCU) whose NativeMessagingHosts subkey browsers read. */
const WINDOWS_KEYS = [
  "Software\\Google\\Chrome",
  "Software\\Chromium",
  "Software\\BraveSoftware\\Brave-Browser",
  "Software\\Microsoft\\Edge",
  "Software\\Vivaldi",
];

export type InstallOptions = {
  /** Point Chrome at the dev shim, which connects to `bun run dev`, instead of starting Agent Bridge itself. */
  dev?: boolean;
  /** Only write the manifest into this NativeMessagingHosts folder (e.g. a test profile's). */
  dir?: string;
  quiet?: boolean;
};

/**
 * The program Chrome runs: this executable, or (running from source) a small
 * launcher script, since a manifest can't pass arguments.
 */
function hostProgram({ dev, dir }: InstallOptions): string {
  if (COMPILED && !dev) return process.execPath;
  const mode = dev ? "shim" : "host";
  const main = path.join(import.meta.dir, "main.ts");
  const where = dir ?? path.join(HOME, "hosts");
  fs.mkdirSync(where, { recursive: true });
  const win = process.platform === "win32";
  const file = path.join(where, `${HOST_NAME}-${mode}${win ? ".cmd" : ""}`);
  // Chrome doesn't pass our environment on, so keep a custom home here.
  const home = process.env.EYEPATCH_HOME;
  const script = win
    ? `@echo off\r\n${home ? `set "EYEPATCH_HOME=${home}"\r\n` : ""}"${process.execPath}" "${main}" ${mode} %*\r\n`
    : `#!/bin/sh\n${home ? `export EYEPATCH_HOME='${home.replace(/'/g, `'\\''`)}'\n` : ""}exec "${process.execPath}" "${main}" ${mode} "$@"\n`;
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

function manifest(program: string) {
  return JSON.stringify(
    {
      name: HOST_NAME,
      description: "Eyepatch Agent Bridge: runs coding agents for the Eyepatch extension",
      path: program,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  );
}

const MANIFEST_FILE = `${HOST_NAME}.json`;

/** Register with every installed browser (or just `dir`). Returns where manifests were written. */
export async function install(opts: InstallOptions = {}): Promise<string[]> {
  const json = manifest(hostProgram(opts));
  const written: string[] = [];
  if (opts.dir) {
    fs.mkdirSync(opts.dir, { recursive: true });
    fs.writeFileSync(path.join(opts.dir, MANIFEST_FILE), json);
    written.push(opts.dir);
  } else if (process.platform === "win32") {
    const dir = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Eyepatch");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, MANIFEST_FILE);
    fs.writeFileSync(file, json);
    for (const key of WINDOWS_KEYS) {
      const full = `HKCU\\${key}\\NativeMessagingHosts\\${HOST_NAME}`;
      const p = Bun.spawn(["reg", "add", full, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdout: "ignore", stderr: "ignore" });
      if ((await p.exited) === 0) written.push(full);
    }
  } else {
    for (const dir of browserDirs()) {
      if (!fs.existsSync(dir)) continue; // that browser isn't installed
      const hosts = path.join(dir, "NativeMessagingHosts");
      fs.mkdirSync(hosts, { recursive: true });
      fs.writeFileSync(path.join(hosts, MANIFEST_FILE), json);
      written.push(hosts);
    }
  }
  if (!opts.quiet) {
    console.log(written.length ? `Registered ${HOST_NAME} with:\n  ${written.join("\n  ")}` : "No Chromium-based browser found to register with.");
  }
  return written;
}

/** Remove every registration (Agent Bridge's own files in ~/.eyepatch are left alone). */
export async function uninstall() {
  if (process.platform === "win32") {
    for (const key of WINDOWS_KEYS) {
      await Bun.spawn(["reg", "delete", `HKCU\\${key}\\NativeMessagingHosts\\${HOST_NAME}`, "/f"], { stdout: "ignore", stderr: "ignore" }).exited;
    }
    const dir = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Eyepatch");
    fs.rmSync(path.join(dir, MANIFEST_FILE), { force: true });
  } else {
    for (const dir of browserDirs()) fs.rmSync(path.join(dir, "NativeMessagingHosts", MANIFEST_FILE), { force: true });
  }
  fs.rmSync(path.join(HOME, "hosts"), { recursive: true, force: true });
  console.log(`Unregistered ${HOST_NAME}.`);
}

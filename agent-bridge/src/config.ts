import os from "node:os";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export const HOME = process.env.EYEPATCH_HOME ?? path.join(os.homedir(), ".eyepatch");
export const MODS_DIR = path.join(HOME, "mods");
export const LOG_DIR = path.join(HOME, "logs");

/** The native messaging host's name, as the extension passes it to connectNative. */
export const HOST_NAME = "eyepatch.agent_bridge";

/**
 * The extension allowed to start Agent Bridge. Fixed by the `key` in
 * extension/manifest.json, so the unpacked copy and the store copy share it.
 */
export const EXTENSION_ID = "ilbbppjdddgjalodmdcmgdigaakgblpe";

/** Whether this is the compiled executable (as opposed to `bun src/main.ts`). */
export const COMPILED = import.meta.dir.includes("$bunfs") || import.meta.dir.includes("~BUN");

/** Unpacked extension dir. In dev mode it's watched so the extension reloads itself on change. */
export const EXTENSION_DIR = process.env.EYEPATCH_EXTENSION_DIR ?? path.resolve(import.meta.dir, "../../extension");

/** Where dev mode's Agent Bridge listens for the dev host shim Chrome starts. */
export const DEV_SOCKET =
  process.platform === "win32" ? `\\\\.\\pipe\\eyepatch-dev-${os.userInfo().username}` : path.join(HOME, "dev.sock");

/**
 * How to run Agent Bridge itself in another mode (e.g. `mcp`): the compiled
 * executable, or Bun with this source file.
 */
export function selfCommand(...args: string[]): { cmd: string; args: string[] } {
  return COMPILED ? { cmd: process.execPath, args } : { cmd: process.execPath, args: [path.join(import.meta.dir, "main.ts"), ...args] };
}

import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { LOG_DIR } from "./config.ts";

/**
 * Logging. When Chrome runs Agent Bridge, stdout carries native messages, so
 * nothing else may be written there: every console method goes to stderr and
 * to ~/.eyepatch/logs/agent-bridge.log instead (rotated at 5 MB).
 */

const MAX_BYTES = 5 * 1024 * 1024;
let file: string | null = null;
let size = 0;

export function setUpLogging({ toFile }: { toFile: boolean }) {
  if (toFile) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    file = path.join(LOG_DIR, "agent-bridge.log");
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  }
  const write = (level: string) => (...args: unknown[]) => log(level, format(...args));
  console.log = console.info = console.debug = write("info");
  console.warn = write("warn");
  console.error = write("error");
}

export function log(level: string, text: string) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${text}\n`;
  process.stderr.write(line);
  if (!file) return;
  try {
    if (size + line.length > MAX_BYTES) {
      fs.renameSync(file, file + ".1");
      size = 0;
    }
    fs.appendFileSync(file, line);
    size += Buffer.byteLength(line);
  } catch {
    // A full disk shouldn't take Agent Bridge down.
  }
}

/** Log a child process's output line by line, prefixed with its name. */
export async function logStream(prefix: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (line) log("info", `[${prefix}] ${line}`);
    }
  }
  if (buf.trim()) log("info", `[${prefix}] ${buf.trim()}`);
}

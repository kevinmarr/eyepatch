#!/usr/bin/env bun
import { startBridge } from "./bridge.ts";
import { HOME, VERSION } from "./config.ts";
import { runDevServer, runShim } from "./dev.ts";
import { setUpLogging } from "./log.ts";
import { connectStdio } from "./native-messaging.ts";
import { install, uninstall } from "./register.ts";
import { runMcpProxy } from "./tools.ts";

/**
 * Agent Bridge's entry point. One executable, several modes:
 *
 *   (started by Chrome)      the native messaging host; Chrome passes the
 *                            caller's origin, chrome-extension://<id>/
 *   install [--dev]          register with every installed Chromium browser
 *   uninstall                remove those registrations
 *   dev                      run in this terminal for development
 *   mcp                      the browser tools' MCP server (agents start it)
 *   shim                     dev mode's host: a pipe to `dev`
 *   host                     the native messaging host, started from source
 */

const USAGE = `Eyepatch Agent Bridge ${VERSION}

Runs coding agents for the Eyepatch Chrome extension, which starts it on
demand. To set it up, run:

  eyepatch-agent-bridge install     register with your Chromium-based browsers
  eyepatch-agent-bridge uninstall   remove the registration

Data lives in ${HOME}.`;

async function runHost() {
  setUpLogging({ toFile: true });
  console.log(`[host] Agent Bridge ${VERSION} started (pid ${process.pid})`);
  const bridge = await startBridge({ dev: false });
  const conn = bridge.extension.attach((onMessage) => connectStdio(onMessage));
  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[host] ${why}; stopping`);
    await bridge.shutdown();
    process.exit(0);
  };
  // Chrome closes our stdin when the extension disconnects (or Chrome quits).
  void conn.closed.then(() => stop("extension disconnected"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const option = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (command?.startsWith("chrome-extension://") || command === "host") {
  await runHost();
} else if (command === "mcp") {
  runMcpProxy();
} else if (command === "shim") {
  runShim();
} else if (command === "dev") {
  setUpLogging({ toFile: false });
  await runDevServer();
} else if (command === "install") {
  await install({ dev: flag("--dev"), dir: option("--dir") });
} else if (command === "uninstall") {
  await uninstall();
} else if (command === "version" || command === "--version") {
  console.log(VERSION);
} else {
  console.log(USAGE);
  process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
}

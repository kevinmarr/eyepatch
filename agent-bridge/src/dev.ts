import fs from "node:fs";
import net from "node:net";
import { startBridge } from "./bridge.ts";
import { DEV_SOCKET, EXTENSION_DIR, HOME, MODS_DIR } from "./config.ts";
import { connect, encode } from "./native-messaging.ts";

/**
 * Development: Agent Bridge runs in a terminal (`bun run dev`) instead of
 * being started by Chrome, so its logs are on screen, it restarts when its
 * source changes, and the extension reloading itself doesn't stop it (or the
 * agents). `bun run register:dev` points Chrome at the shim below, which
 * pipes Chrome's native messaging to this process over a local socket.
 */
export async function runDevServer() {
  const bridge = await startBridge({ dev: true });
  if (process.platform !== "win32") fs.rmSync(DEV_SOCKET, { force: true });
  let current: net.Socket | null = null;
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    // A newer shim (the extension reloaded) replaces the old one.
    current?.destroy();
    current = socket;
    bridge.extension.attach((onMessage) => connect(socket, (bytes) => socket.write(bytes), onMessage));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(DEV_SOCKET, () => resolve());
  });
  if (process.platform !== "win32") fs.chmodSync(DEV_SOCKET, 0o600);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    if (process.platform !== "win32") fs.rmSync(DEV_SOCKET, { force: true });
    await bridge.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Eyepatch Agent Bridge (dev)
  socket     ${DEV_SOCKET}
  home       ${HOME}
  mods       ${MODS_DIR}
  extension  ${EXTENSION_DIR} (reloads on change)
Chrome reaches this through the dev host (bun run register:dev, once).`);
}

/**
 * `eyepatch-agent-bridge shim`: what Chrome starts in dev mode. Passes native messages
 * through to the dev server. If it isn't running, tells the extension so (it
 * shows how to start it) and exits.
 */
export function runShim() {
  const socket = net.connect(DEV_SOCKET, () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on("error", () => {
    process.stdout.write(encode({ type: "dev_bridge_down" }), () => process.exit(1));
  });
  socket.on("close", () => process.exit(0));
  process.stdin.on("end", () => socket.end());
}

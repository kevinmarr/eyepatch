import { AgentHost } from "./agent.js";
import { AgentManager } from "./agents.js";
import { ExtensionSocket } from "./extension-socket.js";
import { EXTENSION_DIR, MODS_DIR, PORT } from "./config.js";
import { ensureModsDir, loadMods, watchDir, watchMods } from "./mods.js";

await ensureModsDir();

const extension = new ExtensionSocket(PORT);
const agents = new AgentManager((msg) => extension.send(msg));
await agents.init();
const agent = new AgentHost(extension, agents);

async function applyMods(changed: string[]) {
  const mods = await loadMods();
  if (!extension.connected) return;
  const { errors } = await extension.call<{ errors: Record<string, string> }>(
    "apply_mods",
    { mods, changed },
    { timeoutMs: 45_000, skipBarrier: true },
  );
  for (const [id, err] of Object.entries(errors ?? {})) console.warn(`[mods] ${id}: ${err}`);
}

function pushMods(changed: string[] = []) {
  const work = applyMods(changed).catch((e) => console.error("[mods] apply failed:", e.message ?? e));
  extension.holdCallsUntil(work);
}

extension.onConnect(() => pushMods());
// User scripts were just allowed: register every mod and reload the tabs it applies to.
extension.on((msg) => {
  if (msg.type === "sync_mods") void loadMods().then((mods) => pushMods(mods.map((m) => m.id)));
});
watchMods((ids) => {
  console.log(`[mods] changed: ${ids.join(", ")}`);
  pushMods(ids);
});

// Dev loop for the extension itself: edit a file in extension/ and it reloads.
watchDir(EXTENSION_DIR, () => {
  console.log("[dev] extension files changed; reloading extension");
  extension.send({ type: "reload_extension" });
});

console.log(`site-modder Agent Bridge
  websocket  ws://127.0.0.1:${PORT}
  mods       ${MODS_DIR}
  extension  ${EXTENSION_DIR} (auto-reload on change)`);

agent.start().catch((e) => {
  console.error("[agent] failed to start:", e);
  process.exitCode = 1;
});

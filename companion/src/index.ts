import { AgentHost } from "./agent.js";
import { Bridge } from "./bridge.js";
import { EXTENSION_DIR, MODS_DIR, PORT } from "./config.js";
import { ensureModsDir, loadMods, watchDir, watchMods } from "./mods.js";

await ensureModsDir();

const bridge = new Bridge(PORT);
const agent = new AgentHost(bridge);

async function applyMods(changed: string[]) {
  const mods = await loadMods();
  if (!bridge.connected) return;
  const { errors } = await bridge.call<{ errors: Record<string, string> }>(
    "apply_mods",
    { mods, changed },
    { timeoutMs: 45_000, skipBarrier: true },
  );
  for (const [id, err] of Object.entries(errors ?? {})) console.warn(`[mods] ${id}: ${err}`);
}

function pushMods(changed: string[] = []) {
  const work = applyMods(changed).catch((e) => console.error("[mods] apply failed:", e.message ?? e));
  bridge.holdCallsUntil(work);
}

bridge.onConnect(() => pushMods());
watchMods((ids) => {
  console.log(`[mods] changed: ${ids.join(", ")}`);
  pushMods(ids);
});

// Dev loop for the extension itself: edit a file in extension/ and it reloads.
watchDir(EXTENSION_DIR, () => {
  console.log("[dev] extension files changed; reloading extension");
  bridge.send({ type: "reload_extension" });
});

console.log(`site-modder companion
  websocket  ws://127.0.0.1:${PORT}
  mods       ${MODS_DIR}
  extension  ${EXTENSION_DIR} (auto-reload on change)`);

agent.start().catch((e) => {
  console.error("[agent] failed to start:", e);
  process.exitCode = 1;
});

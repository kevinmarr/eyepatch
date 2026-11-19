import { AgentManager } from "./agents.js";
import { Chats } from "./chats.js";
import { ExtensionSocket } from "./extension-socket.js";
import { EXTENSION_DIR, MODS_DIR, PORT } from "./config.js";
import { ensureModsDir, loadMods, watchDir, watchMods } from "./mods.js";

await ensureModsDir();

const extension = new ExtensionSocket(PORT);
const agents = new AgentManager((msg) => extension.send(msg));
await agents.init();
const chats = new Chats(extension, agents);

/**
 * Send the mods to the extension. CSS changes hot-swap in every open tab.
 * JS changes reload `reloadTabs`, or every matching tab when that's null.
 */
async function applyMods(changed: string[], reloadTabs: number[] | null) {
  const mods = await loadMods();
  if (!extension.connected) return;
  const { errors } = await extension.call<{ errors: Record<string, string> }>(
    "apply_mods",
    { mods, changed, reloadTabs },
    { timeoutMs: 45_000, skipBarrier: true },
  );
  for (const [id, err] of Object.entries(errors ?? {})) console.warn(`[mods] ${id}: ${err}`);
}

function pushMods(changed: string[] = [], reloadTabs: number[] | null = null) {
  const work = applyMods(changed, reloadTabs).catch((e) => console.error("[mods] apply failed:", e.message ?? e));
  extension.holdCallsUntil(work);
}

extension.onConnect(() => pushMods());
// User scripts were just allowed: register every mod and reload the tabs it applies to.
extension.on((msg) => {
  if (msg.type === "sync_mods") void loadMods().then((mods) => pushMods(mods.map((m) => m.id)));
});
watchMods((ids) => {
  console.log(`[mods] changed: ${ids.join(", ")}`);
  // An agent's edit reloads only its own tab, not other tabs on the same
  // site (which may have their own chats going). A hand edit reloads all.
  const editors = chats.tabsThatEdited(ids);
  pushMods(ids, editors.length ? editors : null);
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



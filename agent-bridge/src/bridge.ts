import { AgentManager } from "./agents.ts";
import { Chats } from "./chats.ts";
import { EXTENSION_DIR } from "./config.ts";
import { Extension } from "./extension.ts";
import { deleteMod, ensureModsDir, importMod, loadMods, revealMod, setModEnabled, watchDir, watchMods } from "./mods.ts";
import { ToolServer } from "./tools.ts";
import { cleanUpAfterUpdate, selfUpdate } from "./update.ts";

/**
 * Agent Bridge itself: agents, chats, browser tools and mods, talking to the
 * extension through `extension` (which the caller connects).
 */
export async function startBridge({ dev }: { dev: boolean }) {
  await ensureModsDir();
  void cleanUpAfterUpdate();

  const extension = new Extension();
  const agents = new AgentManager((msg) => extension.send(msg));
  await agents.init();
  const tools = new ToolServer();
  await tools.listen();
  const chats = new Chats(extension, agents, tools);

  /**
   * Send the mods to the extension. CSS changes hot-swap in every open tab.
   * JS changes reload `reloadTabs`, or every matching tab when that's null.
   */
  async function applyMods(changed: string[], reloadTabs: number[] | null) {
    if (!extension.connected) return;
    const mods = await loadMods({ assets: true });
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
  extension.on((msg) => {
    // The extension wants another version: replace this executable, then it restarts us.
    if (msg.type === "bridge_update") {
      selfUpdate(msg.version).then(
        () => extension.send({ type: "bridge_update_done", version: msg.version }),
        (e: Error) => {
          console.error("[update] failed:", e.message);
          extension.send({ type: "bridge_update_failed", version: msg.version, error: e.message });
        },
      );
    }
    const fail = (id: string) => (e: Error) => console.error(`[mods] ${id}:`, e.message);
    // User scripts were just allowed: register every mod and reload the tabs it applies to.
    if (msg.type === "sync_mods") void loadMods().then((mods) => pushMods(mods.map((m) => m.id)));
    // From the side panel or Options page. The on/off state isn't in the mod's
    // file, so apply it here; the mods watcher applies the rest.
    if (msg.type === "mod_set_enabled") setModEnabled(msg.id, msg.enabled).then(() => pushMods([msg.id]), fail(msg.id));
    if (msg.type === "mod_delete") deleteMod(msg.id).catch(fail(msg.id));
    if (msg.type === "mod_reveal") revealMod(msg.id).catch(fail(msg.id));
    if (msg.type === "mod_import") {
      importMod(msg.fileName, msg.content).then(
        (id) => extension.send({ type: "options_event", event: { type: "mod_imported", requestId: msg.requestId, id } }),
        (e: Error) => extension.send({ type: "options_event", event: { type: "mod_imported", requestId: msg.requestId, error: e.message } }),
      );
    }
  });
  watchMods((ids) => {
    console.log(`[mods] changed: ${ids.join(", ")}`);
    // An agent's edit reloads only its own tab, not other tabs on the same
    // site (which may have their own chats going). A hand edit reloads all.
    const editors = chats.tabsThatEdited(ids);
    pushMods(ids, editors.length ? editors : null);
  });

  // Dev loop for the extension itself: edit a file in extension/ and it reloads.
  if (dev) {
    watchDir(EXTENSION_DIR, () => {
      console.log("[dev] extension files changed; reloading extension");
      extension.send({ type: "reload_extension" });
    });
  }

  return {
    extension,
    /** Save chats and stop agents. */
    shutdown: () => chats.shutdown(),
  };
}

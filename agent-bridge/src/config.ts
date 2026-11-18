import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.SITE_MODDER_PORT ?? 7457);
export const HOME = process.env.SITE_MODDER_HOME ?? path.join(os.homedir(), ".site-modder");
export const MODS_DIR = path.join(HOME, "mods");

/** Unpacked extension dir; watched so the extension reloads itself on change. */
export const EXTENSION_DIR =
  process.env.SITE_MODDER_EXTENSION_DIR ?? path.resolve(here, "../../extension");

/** Optional pin: only accept WebSocket connections from this extension ID. */
export const EXTENSION_ID = process.env.SITE_MODDER_EXTENSION_ID;

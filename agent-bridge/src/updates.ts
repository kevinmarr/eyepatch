import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { HOME, MODS_DIR } from "./config.ts";
import { CSS_EXT, parseUserCssMeta, parseUserScriptMeta, type Meta } from "./modfile.ts";

/**
 * Updates for mods that came from the web. Userscripts and UserCSS styles
 * name where newer versions are (`@updateURL`, `@downloadURL`); a mod
 * installed from a URL also remembers that URL. Agent Bridge checks them
 * once a day (and when asked), and Settings offers each newer version.
 *
 * A mod someone changed (the agent or the user) stops getting offers: we
 * keep a hash of the file as it was installed or last updated, and an
 * update would throw their changes away.
 */

const STATE_FILE = path.join(HOME, "mod-updates.json");
const DAY = 24 * 60 * 60 * 1000;

type Installed = { sha256: string; source?: string };
type Available = { version: string; url: string };
type State = {
  installed: Record<string, Installed>;
  available: Record<string, Available>;
  errors: Record<string, string>;
  lastCheck: number;
};

/** What Settings shows about a mod's updates. */
export type ModUpdate = {
  /** A newer version is ready to install. */
  version?: string;
  /** Changed since it was installed, so updates aren't offered. */
  edited?: boolean;
  /** Why the last check for this mod failed. */
  error?: string;
};

export type UpdatesView = { mods: Record<string, ModUpdate>; checking: boolean; lastCheck: number | null };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

async function readState(): Promise<State> {
  try {
    const s = JSON.parse(await fsp.readFile(STATE_FILE, "utf8"));
    return { installed: s.installed ?? {}, available: s.available ?? {}, errors: s.errors ?? {}, lastCheck: Number(s.lastCheck) || 0 };
  } catch {
    return { installed: {}, available: {}, errors: {}, lastCheck: 0 };
  }
}

// Read-modify-write one at a time.
let writing: Promise<unknown> = Promise.resolve();
function updateState<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
  const next = writing.then(async () => {
    const s = await readState();
    const out = await fn(s);
    await fsp.writeFile(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
    return out;
  });
  writing = next.catch(() => {});
  return next;
}

const metaOf = (id: string, src: string) => (id.endsWith(CSS_EXT) ? parseUserCssMeta(src) : parseUserScriptMeta(src));
const first = (meta: Meta | null, key: string) => meta?.entries.find(([k]) => k === key)?.[1]?.trim() || undefined;

/** Only https, and http to this computer (for testing). */
function allowedUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.href;
  } catch {}
  return undefined;
}

/** Where to look for a newer version (the header, or the small .meta.js), and where to get it. */
function sources(meta: Meta | null, installed?: Installed) {
  const update = allowedUrl(first(meta, "updateURL"));
  const download = allowedUrl(first(meta, "downloadURL"));
  const source = allowedUrl(installed?.source);
  // Greasy Fork's @updateURL is the header only; the script is at .user.js.
  const full = download ?? (update && !/\.meta\.(js|css)$/.test(update) ? update : update?.replace(/\.meta\.(js|css)$/, ".user.$1")) ?? source;
  return { check: update ?? full, download: full };
}

/** -1, 0 or 1, comparing dotted versions part by part (numbers as numbers). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const c = !Number.isNaN(nx) && !Number.isNaN(ny) ? Math.sign(nx - ny) : x < y ? -1 : x > y ? 1 : 0;
    if (c) return c;
  }
  return 0;
}

async function fetchText(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow", headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** A mod was installed or updated from the web (or imported from a file): remember it as is. */
export function recordInstalled(id: string, content: string, source?: string) {
  return updateState((s) => {
    s.installed[id] = { sha256: sha256(content), ...(allowedUrl(source) ? { source } : {}) };
    delete s.available[id];
    delete s.errors[id];
  });
}

/** A mod was deleted. */
export function forgetInstalled(id: string) {
  return updateState((s) => {
    delete s.installed[id];
    delete s.available[id];
    delete s.errors[id];
  });
}

async function modFiles(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of await fsp.readdir(MODS_DIR).catch(() => [] as string[])) {
    if (!/\.user\.(js|css)$/.test(name)) continue;
    out.set(name, await fsp.readFile(path.join(MODS_DIR, name), "utf8").catch(() => ""));
  }
  return out;
}

let checking = false;

/** What Settings shows: each updatable mod's state. */
export async function updatesView(): Promise<UpdatesView> {
  const files = await modFiles();
  return updateState((s) => {
    const mods: Record<string, ModUpdate> = {};
    for (const [id, content] of files) {
      const meta = metaOf(id, content);
      if (!sources(meta, s.installed[id]).check) continue;
      // A mod from before Eyepatch kept hashes: take it as it is now.
      s.installed[id] ??= { sha256: sha256(content) };
      if (s.installed[id].sha256 !== sha256(content)) {
        mods[id] = { edited: true };
        continue;
      }
      const a = s.available[id];
      const current = first(meta, "version") ?? "0";
      mods[id] = {
        ...(a && compareVersions(a.version, current) > 0 ? { version: a.version } : {}),
        ...(s.errors[id] ? { error: s.errors[id] } : {}),
      };
    }
    for (const id of Object.keys(s.installed)) if (!files.has(id)) delete s.installed[id];
    return { mods, checking, lastCheck: s.lastCheck || null };
  });
}

/** Look for newer versions of every updatable mod nobody has edited. */
export async function checkForUpdates(onChange: () => void): Promise<void> {
  if (checking) return;
  checking = true;
  onChange();
  try {
    const files = await modFiles();
    const { installed } = await readState();
    const found: Record<string, Available> = {};
    const errors: Record<string, string> = {};
    await Promise.all(
      [...files].map(async ([id, content]) => {
        const meta = metaOf(id, content);
        const { check, download } = sources(meta, installed[id]);
        if (!check || !download) return;
        if (installed[id] && installed[id].sha256 !== sha256(content)) return;
        try {
          const latest = metaOf(id, await fetchText(check));
          const version = first(latest, "version");
          if (!version) return; // nothing to compare
          if (compareVersions(version, first(meta, "version") ?? "0") > 0) found[id] = { version, url: download };
        } catch (e) {
          errors[id] = (e as Error).message;
        }
      }),
    );
    await updateState((s) => {
      s.available = found;
      s.errors = errors;
      s.lastCheck = Date.now();
    });
  } finally {
    checking = false;
    onChange();
  }
}

/** Install the newer version found for a mod. The mods watcher applies it. */
export async function applyUpdate(id: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]*\.user\.(js|css)$/i.test(id)) throw new Error(`Bad mod id ${id}`);
  const file = path.join(MODS_DIR, id);
  const content = await fsp.readFile(file, "utf8");
  const s = await readState();
  const a = s.available[id];
  if (!a) throw new Error("No update for this mod");
  if (s.installed[id] && s.installed[id].sha256 !== sha256(content)) throw new Error("It was changed since it was installed, so it isn't updated");
  const next = await fetchText(a.url);
  const meta = metaOf(id, next);
  if (!meta) throw new Error(`The update isn't a ${id.endsWith(CSS_EXT) ? "UserCSS style" : "userscript"}`);
  // Same script: same @namespace if it had one, else the same @name.
  const old = metaOf(id, content);
  const same = first(old, "namespace") ? first(old, "namespace") === first(meta, "namespace") : first(old, "name") === first(meta, "name");
  if (!same) throw new Error("The update is a different script (its @name or @namespace changed)");
  await fsp.writeFile(file, next);
  await recordInstalled(id, next, s.installed[id]?.source);
}

/** Check once a day, from when Agent Bridge starts. */
export function scheduleUpdateChecks(onChange: () => void) {
  const tick = async () => {
    const { lastCheck } = await readState();
    if (Date.now() - lastCheck > DAY) await checkForUpdates(onChange).catch((e) => console.warn("[updates]", e.message));
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 60 * 60 * 1000);
}

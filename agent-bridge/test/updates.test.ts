import { afterAll, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { MODS_DIR } from "../src/config.ts";
import { applyUpdate, checkForUpdates, compareVersions, recordInstalled, updatesView } from "../src/updates.ts";

test("compareVersions", () => {
  expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
  expect(compareVersions("1.2", "1.2.0")).toBe(0);
  expect(compareVersions("2", "10")).toBe(-1);
  expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBe(1);
});

const script = (version: string, extra = "") =>
  `// ==UserScript==\n// @name Updatable\n// @namespace test\n// @version ${version}\n// @match https://x.com/*\n${extra}// ==/UserScript==\nconsole.log(${JSON.stringify(version)});\n`;

let latest = "1.1";
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/s.meta.js") return new Response(script(latest).split("// ==/UserScript==")[0] + "// ==/UserScript==\n");
    if (u.pathname === "/s.user.js") return new Response(script(latest));
    if (u.pathname === "/other.user.js") return new Response(script("9").replace("@name Updatable", "@name Other").replace("@namespace test", "@namespace other"));
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop());
const base = `http://127.0.0.1:${server.port}`;

test("an update is found, applied, and not offered once the file is edited", async () => {
  await fs.mkdir(MODS_DIR, { recursive: true });
  const id = "updatable.user.js";
  const file = path.join(MODS_DIR, id);
  const v1 = script("1.0", `// @updateURL ${base}/s.meta.js\n`);
  await fs.writeFile(file, v1);
  await recordInstalled(id, v1);

  await checkForUpdates(() => {});
  expect((await updatesView()).mods[id]).toEqual({ version: "1.1" });

  await applyUpdate(id);
  expect(await fs.readFile(file, "utf8")).toBe(script("1.1"));
  expect((await updatesView()).mods[id]).toBeUndefined(); // the new file has no @updateURL…
  // …but it was installed from a URL, so updates come from there.
  await recordInstalled(id, script("1.1"), `${base}/s.user.js`);
  latest = "1.2";
  await checkForUpdates(() => {});
  expect((await updatesView()).mods[id]).toEqual({ version: "1.2" });

  await fs.writeFile(file, script("1.1") + "// my change\n");
  expect((await updatesView()).mods[id]).toEqual({ edited: true });
  await expect(applyUpdate(id)).rejects.toThrow(/changed/);
  await fs.rm(file);
});

test("an update that's a different script isn't installed", async () => {
  const id = "swap.user.js";
  const v1 = script("1.0", `// @downloadURL ${base}/other.user.js\n`);
  await fs.writeFile(path.join(MODS_DIR, id), v1);
  await recordInstalled(id, v1);
  await checkForUpdates(() => {});
  expect((await updatesView()).mods[id]?.version).toBe("9");
  await expect(applyUpdate(id)).rejects.toThrow(/different script/);
  await fs.rm(path.join(MODS_DIR, id));
});

test("plain http update URLs (other than this computer) are ignored", async () => {
  const id = "insecure.user.js";
  const v1 = script("1.0", `// @updateURL http://example.com/s.meta.js\n`);
  await fs.writeFile(path.join(MODS_DIR, id), v1);
  expect((await updatesView()).mods[id]).toBeUndefined();
  await fs.rm(path.join(MODS_DIR, id));
});

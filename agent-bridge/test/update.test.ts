import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selfUpdate } from "../src/update.ts";

// A fake release server: v0.2.0 has a "build" (a script that prints its
// version) for linux-x64; v0.3.0's checksum is wrong; v0.4.0's build says
// it's 0.2.0.
const TARGET = "linux-x64";
const ASSET = `eyepatch-agent-bridge-${TARGET}.tar.gz`;
let dir: string;
let server: ReturnType<typeof Bun.serve>;
const files = new Map<string, Uint8Array<ArrayBuffer>>();

async function release(version: string, prints: string, sumsFor?: Uint8Array<ArrayBuffer>) {
  const build = path.join(dir, `build-${version}`);
  await fs.mkdir(build);
  await fs.writeFile(path.join(build, "eyepatch-agent-bridge"), `#!/bin/sh\necho ${prints}\n`, { mode: 0o755 });
  const tarball = path.join(dir, `${version}.tar.gz`);
  await Bun.spawn(["tar", "-czf", tarball, "-C", build, "eyepatch-agent-bridge"]).exited;
  const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
  const sum = new Bun.CryptoHasher("sha256").update(sumsFor ?? bytes).digest("hex");
  files.set(`/v${version}/${ASSET}`, bytes);
  files.set(`/v${version}/SHA256SUMS`, new TextEncoder().encode(`${sum}  ${ASSET}\n`));
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "eyepatch-update-"));
  await release("0.2.0", "0.2.0");
  await release("0.3.0", "0.3.0", new Uint8Array([1, 2, 3]));
  await release("0.4.0", "0.2.0");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const body = files.get(new URL(req.url).pathname);
      return body ? new Response(body) : new Response("not found", { status: 404 });
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await fs.rm(dir, { recursive: true, force: true });
});

async function installed(version: string) {
  const app = await fs.mkdtemp(path.join(dir, "app-"));
  const exe = path.join(app, "eyepatch-agent-bridge");
  await fs.writeFile(exe, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return exe;
}

const opts = (exe: string) => ({ exe, target: TARGET, releases: `http://127.0.0.1:${server.port}` });
const version = async (exe: string) => (await new Response(Bun.spawn([exe, "version"]).stdout).text()).trim();

test("replaces the executable with the release's", async () => {
  const exe = await installed("0.1.0");
  await selfUpdate("0.2.0", opts(exe));
  assert.equal(await version(exe), "0.2.0");
  assert.deepEqual(await fs.readdir(path.dirname(exe)), ["eyepatch-agent-bridge"]); // no leftovers
});

test("refuses a download that doesn't match SHA256SUMS", async () => {
  const exe = await installed("0.1.0");
  await assert.rejects(selfUpdate("0.3.0", opts(exe)), /checksum/);
  assert.equal(await version(exe), "0.1.0");
});

test("refuses a build that says it's another version", async () => {
  const exe = await installed("0.1.0");
  await assert.rejects(selfUpdate("0.4.0", opts(exe)), /says it's version 0\.2\.0/);
  assert.equal(await version(exe), "0.1.0");
});

test("fails cleanly when the release doesn't exist", async () => {
  const exe = await installed("0.1.0");
  await assert.rejects(selfUpdate("9.9.9", opts(exe)), /HTTP 404/);
  assert.equal(await version(exe), "0.1.0");
  assert.deepEqual(await fs.readdir(path.dirname(exe)), ["eyepatch-agent-bridge"]);
});

test("refuses anything that isn't a plain version", async () => {
  const exe = await installed("0.1.0");
  await assert.rejects(selfUpdate("../../x", opts(exe)), /Not a version/);
});

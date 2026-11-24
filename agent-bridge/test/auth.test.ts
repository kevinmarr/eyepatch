import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { AuthManager } from "../src/auth.ts";
import { MODS_DIR } from "../src/config.ts";
import { ensureModsDir } from "../src/mods.ts";

type View = ReturnType<AuthManager["view"]>;

/** An AuthManager for an agent with no running connection and one terminal sign-in method. */
function manager(script: string) {
  const sent: View[] = [];
  let restarts = 0;
  const auth = new AuthManager({
    send: (msg) => sent.push((msg as { auth: View }).auth),
    conn: () => undefined,
    launchSpec: () => ({ cmd: "sh", args: ["-c", script], env: {} }),
    restartAgent: () => void restarts++,
  });
  const init = { protocolVersion: 1, authMethods: [{ id: "login", name: "Log in", type: "terminal" }], agentInfo: { name: "fake", title: "Fake" } };
  auth.onInitialized(init as unknown as acp.InitializeResponse);
  return { auth, sent, last: () => sent[sent.length - 1], restarts: () => restarts, init };
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(20);
  assert.ok(ok());
};

test("tests use a temporary home (test/setup.ts)", () => {
  assert.ok(MODS_DIR.startsWith(os.tmpdir()), MODS_DIR);
});

test("a finished terminal sign-in asks for a restart and waits for it", async () => {
  await ensureModsDir(); // sign-in commands run there
  const m = manager("echo signed in");
  await m.auth.start("login");
  await until(() => m.restarts() === 1);
  // Not restarted yet (chats mid-reply): the row says so.
  assert.equal(m.last().restartPending, true);
  assert.equal(m.last().signIn, null);
  // The restart happened: a fresh initialize clears it.
  m.auth.onInitialized(m.init as unknown as acp.InitializeResponse);
  await until(() => m.last().restartPending === false);
});

test("a failed terminal sign-in doesn't restart the agent", async () => {
  await ensureModsDir();
  const m = manager("echo nope; exit 3");
  await m.auth.start("login");
  await until(() => Boolean(m.last().error));
  assert.equal(m.restarts(), 0);
  assert.match(m.last().error ?? "", /exit 3/);
});

test("Check again shows checking until the agent's status comes back", async () => {
  const m = manager("true");
  m.auth.beginCheck();
  assert.equal(m.last().checking, true);
  await m.auth.refresh(); // what happens after the restart
  assert.equal(m.last().checking, false);
});

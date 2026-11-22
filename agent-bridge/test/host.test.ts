// Runs Agent Bridge as Chrome would (native messaging over stdio) with a fake
// agent, and plays the extension's part.
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Decoder, encode, Unchunker, type Message } from "../src/native-messaging.ts";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "eyepatch-host-test-"));
const MODS = path.join(HOME, "mods");
fs.mkdirSync(MODS, { recursive: true });
// Bigger than Chrome's 1 MB message limit, so apply_mods has to be chunked.
const bigBody = "/* filler */\n".repeat(100_000);
fs.writeFileSync(path.join(MODS, "big.user.css"), `/* ==UserStyle==\n@name Big\n==/UserStyle== */\n@-moz-document domain("example.com") {\n${bigBody}}\n`);

// EYEPATCH_TEST_BINARY=dist/<platform>/agent-bridge tests the compiled
// executable instead. The fake agent then runs on it acting as Bun
// (BUN_BE_BUN=1, inherited by the browser tools' MCP server), as npm agents do.
const BINARY = process.env.EYEPATCH_TEST_BINARY && path.resolve(process.env.EYEPATCH_TEST_BINARY);
const FAKE_AGENT = path.join(import.meta.dir, "fake-agent.ts");
const ORIGIN = "chrome-extension://ilbbppjdddgjalodmdcmgdigaakgblpe/";
const bridge = Bun.spawn(BINARY ? [BINARY, ORIGIN] : ["bun", path.join(import.meta.dir, "../src/main.ts"), ORIGIN], {
  env: {
    ...process.env,
    EYEPATCH_HOME: HOME,
    EYEPATCH_AGENT: BINARY ? `env BUN_BE_BUN=1 ${BINARY} ${FAKE_AGENT}` : `bun ${FAKE_AGENT}`,
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
afterAll(() => {
  if (process.env.DEBUG) console.log(stderr);
  bridge.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
});

const send = (msg: Message) => {
  bridge.stdin.write(encode(msg));
  bridge.stdin.flush();
};
const inbox: Message[] = [];
let wake: () => void = () => {};
let maxFrame = 0;
void (async () => {
  const d = new Decoder();
  const u = new Unchunker();
  for await (const chunk of bridge.stdout) {
    for (const m of d.push(chunk)) {
      maxFrame = Math.max(maxFrame, JSON.stringify(m).length);
      const full = u.take(m);
      if (full) inbox.push(full);
    }
    wake();
  }
})();
let stderr = "";
void (async () => {
  for await (const c of bridge.stderr) stderr += new TextDecoder().decode(c);
})();

/** The next message matching `pred` (earlier ones stay in the inbox). */
async function next(pred: (m: Message) => boolean, ms = 15_000): Promise<Message> {
  const deadline = Date.now() + ms;
  for (;;) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`timed out; got ${inbox.map((m) => m.type).join(", ")}\n${stderr.slice(-2000)}`);
    await Promise.race([new Promise<void>((r) => (wake = r)), Bun.sleep(100)]);
  }
}

test("pushes mods on connect, chunked when too big for one message", async () => {
  send({ type: "hello", tabs: [1] });
  const call = await next((m) => m.type === "tool_call" && m.method === "apply_mods");
  const mods = (call.params as { mods: { id: string; css?: string }[] }).mods;
  expect(mods.map((m) => m.id)).toEqual(["big.user.css"]);
  expect(JSON.stringify(mods).length).toBeGreaterThan(1024 * 1024);
  expect(maxFrame).toBeLessThan(1024 * 1024);
  send({ type: "tool_result", id: call.id, result: { errors: {} } });
});

test("a chat's agent reaches the browser tools through `agent-bridge mcp`", async () => {
  send({ type: "open_chat", tabId: 1 });
  await next((m) => m.type === "chat" && Boolean((m.chat as { ready: boolean; sessionId: string | null }).sessionId));
  send({ type: "prompt", tabId: 1, text: "call get_tab", page: { tabId: 1, url: "https://example.com/", title: "Example" } });
  const call = await next((m) => m.type === "tool_call" && m.method === "get_tab");
  expect((call.params as { tabId: number }).tabId).toBe(1);
  send({ type: "tool_result", id: call.id, result: { url: "https://example.com/from-the-tab" } });
  const reply = await next((m) => m.type === "session_update");
  expect(JSON.stringify(reply.update)).toContain("from-the-tab");
  await next((m) => m.type === "turn_end");
});

test("exits when the extension disconnects, cleaning up", async () => {
  const sockets = () => fs.readdirSync(HOME).filter((f) => f.startsWith("tools-"));
  expect(sockets()).toHaveLength(1);
  bridge.stdin.end();
  const code = await Promise.race([bridge.exited, Bun.sleep(10_000).then(() => "timeout")]);
  expect(code).toBe(0);
  expect(sockets()).toHaveLength(0);
  expect(fs.readdirSync(path.join(HOME, "sessions")).length).toBe(1); // the chat was saved
  expect(fs.readFileSync(path.join(HOME, "logs", "agent-bridge.log"), "utf8")).toContain("extension disconnected");
}, 15_000);

import { expect, test } from "bun:test";
import { splitCommand } from "../src/agents.ts";

test("splitCommand splits words and keeps quoted ones together", () => {
  expect(splitCommand("gemini --experimental-acp")).toEqual(["gemini", "--experimental-acp"]);
  expect(splitCommand(`  "/Applications/My Agent/agent" --acp 'a b'  `)).toEqual(["/Applications/My Agent/agent", "--acp", "a b"]);
  expect(splitCommand(`node "" x`)).toEqual(["node", "", "x"]);
  expect(() => splitCommand(`agent "oops`)).toThrow();
});

test("a command that speaks ACP can be added, launched and removed", async () => {
  const { AgentManager } = await import("../src/agents.ts");
  const { ensureModsDir } = await import("../src/mods.ts");
  await ensureModsDir();
  const views: any[] = [];
  const m = new AgentManager((msg) => views.push(msg.agents));
  await m.init();
  const fake = `${import.meta.dir}/fake-agent.ts`;
  const id = await m.addLocal(`bun "${fake}"`);
  expect(id).toBe("local:bun");
  expect(m.defaultId).toBe(id);
  expect(m.launchSpec(id!)?.args).toEqual([fake]);
  expect(m.view().list.find((a) => a.id === id)?.installedVersion).toBe("local");

  expect(await m.addLocal("no-such-agent-command --acp")).toBeNull();
  expect(m.view().adding?.error).toContain("Couldn’t find");

  await m.remove(id!);
  expect(m.isInstalled(id!)).toBe(false);
}, 30_000);

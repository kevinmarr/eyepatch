// A minimal ACP agent for tests. On session/new it starts the MCP servers it
// was given (Eyepatch's browser tools); on each prompt it calls the browser
// tool named in the prompt (default get_tab) and replies with the result.

type Json = Record<string, any>;
const out = (msg: Json) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

/** A stdio MCP client, just enough to call tools. */
function startMcp(server: { command: string; args: string[]; env?: { name: string; value: string }[] }) {
  const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value])) };
  const child = Bun.spawn([server.command, ...server.args], { env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const waiting = new Map<number, (r: Json) => void>();
  let seq = 0;
  void (async () => {
    let buf = "";
    for await (const chunk of child.stdout) {
      buf += new TextDecoder().decode(chunk);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        waiting.get(msg.id)?.(msg);
      }
    }
  })();
  const request = (method: string, params: Json) =>
    new Promise<Json>((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      child.stdin.flush();
    });
  const ready = request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" } }).then(() => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.flush();
  });
  return { request: async (method: string, params: Json) => (await ready, request(method, params)) };
}

const sessions = new Map<string, ReturnType<typeof startMcp>>();

async function handle(msg: Json) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return out({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "fake", title: "Fake Agent" } } });
  }
  if (method === "session/new") {
    const sessionId = `s${sessions.size + 1}`;
    const tools = params.mcpServers?.[0];
    if (tools) sessions.set(sessionId, startMcp(tools));
    return out({ id, result: { sessionId } });
  }
  if (method === "session/prompt") {
    const mcp = sessions.get(params.sessionId);
    const prompt = params.prompt.map((b: Json) => b.text ?? "").join("");
    const tool = /call (\w+)/.exec(prompt)?.[1] ?? "get_tab";
    const res = mcp ? await mcp.request("tools/call", { name: tool, arguments: {} }) : { error: "no tools" };
    const text = res.result?.content?.map((c: Json) => c.text ?? `[${c.type}]`).join("\n") ?? JSON.stringify(res.error);
    out({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    return out({ id, result: { stopReason: "end_turn" } });
  }
  if (id !== undefined && method) out({ id, error: { code: -32601, message: `no ${method}` } });
}

let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) void handle(JSON.parse(line));
  }
}

export {};

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { createBrowserServer, type BrowserCall } from "./browser-tools.ts";
import { HOME, selfCommand } from "./config.ts";

/**
 * One per Agent Bridge process: several can run at once (one per Chrome
 * profile). Unix sockets have a short path limit (~104 bytes on macOS).
 */
function socketPath() {
  const id = `${process.pid}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\eyepatch-tools-${os.userInfo().username}-${id}`;
  const inHome = path.join(HOME, `tools-${id}.sock`);
  return inHome.length < 100 ? inHome : path.join(os.tmpdir(), `eyepatch-${process.getuid?.() ?? 0}-${id}.sock`);
}

/**
 * Serves the browser tools to agents. Each conversation gets a token and an
 * MCP server declaration for session/new: the agent starts `agent-bridge mcp`,
 * which connects here and presents its token, and its tool calls run against
 * that conversation's tab. Works with any ACP agent (stdio MCP servers are
 * required by ACP).
 */
export class ToolServer {
  readonly path = socketPath();
  private routes = new Map<string, BrowserCall>();
  private server = net.createServer((socket) => this.accept(socket));

  async listen() {
    if (process.platform !== "win32") fs.rmSync(this.path, { force: true });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => resolve());
    });
    if (process.platform !== "win32") {
      fs.chmodSync(this.path, 0o600);
      process.on("exit", () => fs.rmSync(this.path, { force: true }));
    }
  }

  /** Tools for one conversation. Dispose when the conversation ends. */
  register(call: BrowserCall): { server: acp.McpServer; dispose: () => void } {
    const token = randomBytes(24).toString("hex");
    this.routes.set(token, call);
    const { cmd, args } = selfCommand("mcp");
    return {
      server: {
        name: "eyepatch", // not "browser": some agents have their own tool by that name
        command: cmd,
        args,
        env: [
          { name: "EYEPATCH_TOOLS_SOCKET", value: this.path },
          { name: "EYEPATCH_TOOLS_TOKEN", value: token },
          // Agents run with Bun inherit BUN_BE_BUN=1 (see agents.ts), which
          // would make our executable act as Bun instead of starting `mcp`.
          { name: "BUN_BE_BUN", value: "0" },
        ],
      },
      dispose: () => this.routes.delete(token),
    };
  }

  private accept(socket: net.Socket) {
    // The first line is the token; everything after it is MCP.
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(10);
      if (nl < 0) {
        if (head.length > 200) socket.destroy();
        return;
      }
      socket.off("data", onData);
      socket.pause();
      const call = this.routes.get(head.subarray(0, nl).toString().trim());
      if (!call) return socket.destroy();
      const rest = head.subarray(nl + 1);
      if (rest.length) socket.unshift(rest);
      const transport = new StdioServerTransport(socket, socket);
      void createBrowserServer(call)
        .connect(transport)
        .then(() => socket.resume()); // paused above, so data waits for the transport
      socket.on("close", () => void transport.close());
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  }
}

/**
 * `agent-bridge mcp`: the browser tools' MCP server as the agent sees it, a
 * stdio server it starts for each conversation. It's only a pipe to the
 * Agent Bridge that started the agent: it connects to its socket, presents
 * the conversation's token, and passes MCP messages through both ways.
 */
export function runMcpProxy() {
  const { EYEPATCH_TOOLS_SOCKET: socketPath, EYEPATCH_TOOLS_TOKEN: token } = process.env;
  if (!socketPath || !token) {
    process.stderr.write("Eyepatch browser tools: missing EYEPATCH_TOOLS_SOCKET or EYEPATCH_TOOLS_TOKEN\n");
    process.exit(1);
  }
  const socket = net.connect(socketPath, () => {
    socket.write(token + "\n");
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on("error", (e) => {
    process.stderr.write(`Eyepatch browser tools: can't reach Agent Bridge (${e.message})\n`);
    process.exit(1);
  });
  socket.on("close", () => process.exit(0));
  process.stdin.on("end", () => socket.end());
}

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import { createBrowserServer, type BrowserCall } from "./browser-tools.js";
import { HOME, PORT } from "./config.js";

/** The stdio MCP server agents start; a pipe back to this socket. */
const PROXY = fileURLToPath(new URL("../bin/browser-mcp.mjs", import.meta.url));

/** Unix sockets have a short path limit (~104 bytes on macOS). */
function socketPath() {
  if (process.platform === "win32") return `\\\\.\\pipe\\Eyepatch-${os.userInfo().username}-${PORT}`;
  const inHome = path.join(HOME, `tools-${PORT}.sock`);
  return inHome.length < 100 ? inHome : path.join(os.tmpdir(), `eyepatch-${process.getuid?.() ?? 0}-${PORT}.sock`);
}

/**
 * Serves the browser tools to agents. Each conversation gets a token and an
 * MCP server declaration for session/new: the agent starts bin/browser-mcp.mjs,
 * which connects here and presents its token, and its tool calls run against
 * that conversation's tab. Works with any ACP agent (stdio MCP servers are
 * required by ACP), unlike MCP-over-ACP.
 */
export class ToolSocket {
  readonly path = socketPath();
  private routes = new Map<string, BrowserCall>();
  private server = net.createServer((socket) => this.accept(socket));

  async listen() {
    if (process.platform !== "win32") fs.rmSync(this.path, { force: true }); // left over from a crash
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
    return {
      server: {
        name: "eyepatch", // not "browser": some agents have their own tool by that name
        command: process.execPath,
        args: [PROXY],
        env: [
          { name: "EYEPATCH_TOOLS_SOCKET", value: this.path },
          { name: "EYEPATCH_TOOLS_TOKEN", value: token },
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

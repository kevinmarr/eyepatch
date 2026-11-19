#!/usr/bin/env node
// The browser tools' MCP server, as the agent sees it: a stdio MCP server the
// agent starts for each conversation. It's only a pipe: it connects to the
// running Agent Bridge over a local socket, identifies the conversation with
// its token, and passes MCP messages through in both directions. The tools
// themselves run in Agent Bridge (src/tool-socket.ts).
import net from "node:net";

const { SITE_MODDER_TOOLS_SOCKET: socketPath, SITE_MODDER_TOOLS_TOKEN: token } = process.env;
if (!socketPath || !token) {
  process.stderr.write("site-modder browser tools: missing SITE_MODDER_TOOLS_SOCKET or SITE_MODDER_TOOLS_TOKEN\n");
  process.exit(1);
}

const socket = net.connect(socketPath, () => {
  socket.write(token + "\n");
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (e) => {
  process.stderr.write(`site-modder browser tools: can't reach Agent Bridge (${e.message})\n`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { AgentManager } from "./agents.js";
import { AUTH_REQUIRED, AuthManager } from "./auth.js";
import type { ExtensionSocket, FromExtension, PageInfo } from "./extension-socket.js";
import { createBrowserTools } from "./browser-tools.js";
import { MODS_DIR } from "./config.js";
import { modApplies } from "./match.js";
import { loadMods, type Mod } from "./mods.js";

const READ_ONLY_BROWSER_TOOLS = new Set(
  ["get_tab", "get_page_content", "query_selector_all", "screenshot", "get_console_logs"].map(
    (t) => `mcp__browser__${t}`,
  ),
);

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Context prepended to each user message: the active tab, and the mods that
 * apply to it (matched the same way Chrome does), so the agent knows what's
 * already running without searching.
 */
async function pageContext(page: PageInfo) {
  if (!page.url) return "";
  const lines = [`<active-tab url="${attr(page.url)}" title="${attr(page.title ?? "")}" />`];
  let mods: Mod[] = [];
  try {
    mods = (await loadMods()).filter((m) => m.matches.length && modApplies(m, page.url!));
  } catch (e) {
    console.error("[agent] could not load mods for context:", e);
  }
  if (mods.length) {
    lines.push("<mods-on-this-page>");
    for (const m of mods) {
      const files = ["mod.json", m.css !== undefined && "mod.css", m.js !== undefined && "mod.js"].filter(Boolean);
      const flags = [!m.enabled && "disabled", m.error && `error: ${m.error}`].filter(Boolean);
      lines.push(
        `  ${m.id}/ — ${m.name}${m.description ? `: ${m.description}` : ""} (${files.join(", ")})${flags.length ? ` [${flags.join("; ")}]` : ""}`,
      );
    }
    lines.push("</mods-on-this-page>");
  } else {
    lines.push("<mods-on-this-page>none</mods-on-this-page>");
  }
  return lines.join("\n") + "\n\n";
}

/** Runs one ACP agent subprocess and drives it on behalf of the extension. */
export class AgentHost {
  private child?: ChildProcess;
  private conn?: acp.ClientConnection;
  private browserServer?: acp.McpServerRegistration;
  private supportsAcpMcp = false;
  private agentName: string | null = null;
  private ready = false;
  private sessionId?: string;
  private busy = false;
  private permissionSeq = 0;
  private pendingPermissions = new Map<string, (optionId: string | null) => void>();
  private readonly mcp = new acp.McpOverAcpProvider();
  private readonly tools: ReturnType<typeof createBrowserTools>;
  private readonly auth: AuthManager;

  constructor(
    private readonly extension: ExtensionSocket,
    private readonly agents: AgentManager,
  ) {
    this.tools = createBrowserTools(extension);
    this.auth = new AuthManager({
      send: (msg) => extension.send(msg),
      conn: () => this.conn,
      launchSpec: () => agents.launchSpec(),
      restartAgent: () => this.restart(),
    });
    extension.on((msg) => this.onExtensionMessage(msg));
    extension.onConnect(() => {
      this.sendStatus();
      this.auth.send();
      agents.sendView();
    });
    agents.onChange((reason) => {
      if (reason === "selected") {
        // A different agent: start over with a fresh conversation.
        this.extension.send({ type: "agent_changed" });
        void this.restart();
      } else if (!this.busy) {
        void this.restart(); // a newer copy of the same agent
      } else {
        this.restartWhenIdle = true;
      }
    });
  }

  private restartWhenIdle = false;
  private quickExits = 0;

  /** Stop the agent process and start a fresh one (new credentials or env). */
  async restart() {
    const old = this.child;
    this.child = undefined; // so its exit handler doesn't schedule another restart
    this.conn?.close();
    this.reset();
    old?.kill();
    await this.start().catch((e) => console.error("[agent] restart failed:", e));
  }

  async start() {
    this.restartWhenIdle = false;
    const spec = this.agents.launchSpec();
    if (!spec) {
      console.log("[agent] no agent chosen yet; pick one in the side panel");
      this.agentName = null;
      this.sendStatus();
      return;
    }
    void this.agents.pruneOldVersions();
    const { cmd, args } = spec;
    console.log(`[agent] starting: ${path.basename(cmd)} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: MODS_DIR,
      stdio: ["pipe", "pipe", "inherit"],
      // Claude Code defers MCP tools behind a ToolSearch step by default; our
      // browser tools are used in nearly every turn, so load them upfront.
      env: { ENABLE_TOOL_SEARCH: "false", ...process.env, ...spec.env },
    });
    this.child = child;
    child.on("error", (e) => console.error(`[agent] couldn't start ${cmd}: ${e.message}`));
    const startedAt = Date.now();
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      // Back off if it keeps dying right away (broken install, bad config).
      this.quickExits = Date.now() - startedAt < 15_000 ? this.quickExits + 1 : 0;
      const delay = Math.min(2000 * 2 ** this.quickExits, 60_000);
      console.error(`[agent] exited (${signal ?? code}); restarting in ${delay / 1000}s`);
      this.child = undefined;
      this.conn?.close();
      this.reset();
      setTimeout(() => {
        if (!this.child) this.start().catch((e) => console.error("[agent] restart failed:", e));
      }, delay);
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const app = acp
      .client({ name: "site-modder" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.sessionId === this.sessionId) {
          this.extension.send({ type: "session_update", update: params.update });
        }
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) =>
        this.requestPermission(params, signal),
      )
      .onRequest(acp.methods.client.mcp.message, this.mcp.handleRequest)
      .onNotification(acp.methods.client.auth.statusUpdate, ({ params }) => this.auth.onStatusUpdate(params));

    this.conn = app.connect(stream);

    const init = await this.conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // We can run "terminal" sign-in methods (output and input relayed to
        // the side panel). The _meta flag is the older form some agents use.
        auth: { terminal: true },
        _meta: { "terminal-auth": true },
      },
      clientInfo: { name: "site-modder", version: "0.1.0" },
    });
    this.agentName = init.agentInfo?.title ?? init.agentInfo?.name ?? "agent";
    this.supportsAcpMcp = Boolean(init.agentCapabilities?.mcpCapabilities?.acp);
    if (!this.supportsAcpMcp) {
      console.warn("[agent] agent does not support MCP-over-ACP; browser tools are unavailable");
    }
    this.browserServer = this.mcp.registerServer(this.conn.agent, {
      name: "browser",
      handler: this.tools.handler,
    });
    this.auth.onInitialized(init);
    this.ready = true;
    console.log(`[agent] ready: ${this.agentName} (protocol v${init.protocolVersion})`);
    this.sendStatus();
  }

  private reset() {
    this.ready = false;
    this.busy = false;
    this.sessionId = undefined;
    this.browserServer = undefined;
    this.cancelPendingPermissions();
    this.sendStatus();
  }

  private sendStatus() {
    this.extension.send({
      type: "status",
      agent: this.agentName,
      needsAgent: !this.agents.launchSpec(),
      browserTools: this.supportsAcpMcp,
      ready: this.ready,
      busy: this.busy,
      sessionId: this.sessionId ?? null,
      modsDir: MODS_DIR,
    });
  }

  private onExtensionMessage(msg: FromExtension) {
    switch (msg.type) {
      case "prompt":
        void this.prompt(msg.text, msg.page);
        break;
      case "cancel":
        void this.cancel();
        break;
      case "new_session":
        void this.newSession();
        break;
      case "permission_response":
        this.pendingPermissions.get(msg.id)?.(msg.optionId);
        break;
      case "hello":
        this.sendStatus();
        this.auth.send();
        break;
      case "auth_start":
        void this.auth.start(msg.methodId);
        break;
      case "auth_input":
        this.auth.input(msg.text);
        break;
      case "auth_cancel":
        this.auth.cancel();
        break;
      case "auth_recheck":
        // The user may have signed in outside site-modder; a fresh agent
        // process re-reads its credentials and reports status again.
        if (!this.busy) void this.restart();
        break;
      case "auth_logout":
        void this.newSession().then(() => this.auth.logout());
        break;
      case "agent_select":
        if (!this.busy) void this.agents.select(msg.id);
        break;
      case "agents_refresh":
        void this.agents.refresh();
        break;
    }
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const mcpServers: acp.McpServer[] =
      this.supportsAcpMcp && this.browserServer ? [this.browserServer.declaration] : [];
    const res = await this.conn!.agent.request(acp.methods.agent.session.new, {
      cwd: MODS_DIR,
      mcpServers,
    });
    this.sessionId = res.sessionId;
    // Mods live in their own directory and apply live, so don't prompt for
    // every file edit. Commands and other tools still ask in the side panel.
    const acceptEdits = res.modes?.availableModes.find((m) => m.id === "acceptEdits");
    if (acceptEdits) {
      await this.conn!.agent.request(acp.methods.agent.session.setMode, {
        sessionId: res.sessionId,
        modeId: acceptEdits.id,
      });
    }
    return res.sessionId;
  }

  private async prompt(text: string, page?: PageInfo) {
    if (!this.ready || !this.conn) {
      this.extension.send({ type: "error", message: "The agent is still starting. Try again in a moment." });
      return;
    }
    if (this.busy) {
      this.extension.send({ type: "error", message: "Agent is busy; stop it or wait for it to finish" });
      return;
    }
    if (this.auth.needsSignIn) {
      this.extension.send({ type: "error", message: `Sign in to ${this.agentName} first.` });
      return;
    }
    this.busy = true;
    this.sendStatus();
    try {
      const sessionId = await this.ensureSession();
      this.sendStatus();
      const context = page ? await pageContext(page) : "";
      const res = await this.conn.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: context + text }],
      });
      this.extension.send({ type: "turn_end", stopReason: res.stopReason });
    } catch (e) {
      console.error("[agent] prompt failed:", e);
      const authRequired = (e as { code?: number }).code === AUTH_REQUIRED;
      if (authRequired) this.auth.markAuthRequired();
      this.extension.send({
        type: "error",
        message: authRequired ? `Sign in to ${this.agentName} to continue.` : String((e as Error).message ?? e),
      });
      this.extension.send({ type: "turn_end", stopReason: "error" });
    } finally {
      this.busy = false;
      this.sendStatus();
      this.auth.refreshIfUnknown();
      if (this.restartWhenIdle) void this.restart();
    }
  }

  private async cancel() {
    this.cancelPendingPermissions();
    if (this.sessionId && this.busy) {
      await this.conn?.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
    }
  }

  private async newSession() {
    await this.cancel();
    this.sessionId = undefined;
    this.sendStatus();
  }

  private requestPermission(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    if (!this.extension.connected) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    // Read-only browser tools don't need a prompt. run_js and reload_tab still ask.
    if (READ_ONLY_BROWSER_TOOLS.has(params.toolCall.title ?? "")) {
      const allow = params.options.find((o) => o.kind === "allow_once");
      if (allow) return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    const id = `p${++this.permissionSeq}`;
    return new Promise((resolve) => {
      const done = (optionId: string | null) => {
        this.pendingPermissions.delete(id);
        this.extension.send({ type: "permission_resolved", id });
        resolve(
          optionId
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } },
        );
      };
      this.pendingPermissions.set(id, done);
      signal.addEventListener("abort", () => done(null), { once: true });
      this.extension.send({
        type: "permission_request",
        id,
        toolCall: params.toolCall,
        options: params.options,
      });
    });
  }

  private cancelPendingPermissions() {
    for (const done of [...this.pendingPermissions.values()]) done(null);
  }
}

import path from "node:path";
import type { Subprocess } from "bun";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { AgentManager } from "./agents.ts";
import { AuthManager } from "./auth.ts";
import { MODS_DIR, VERSION } from "./config.ts";
import { logStream } from "./log.ts";

type Child = Subprocess<"pipe", "pipe", "pipe">;

/** What a chat registers to receive its session's traffic. */
export type SessionHandlers = {
  onUpdate: (update: acp.SessionUpdate) => void;
  onPermission: (params: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<acp.RequestPermissionResponse>;
};

type Deps = {
  agents: AgentManager;
  /** Send a message to the extension. */
  send: (msg: Record<string, unknown>) => void;
  /** The process came up (or came back): chats can start sessions. */
  onReady: (agent: AgentProcess) => void;
  /** The process went away: every session on it is gone. */
  onReset: (agent: AgentProcess) => void;
};

/**
 * One running ACP agent (e.g. Claude Agent). Several tabs can use the same
 * agent at once; each gets its own session on this one process.
 */
export class AgentProcess {
  name: string;
  ready = false;
  conn?: acp.ClientConnection;
  /** How the agent can reopen an earlier conversation, if at all. */
  reopen: "resume" | "load" | null = null;
  /** Whether prompts can include images. */
  images = false;
  readonly auth: AuthManager;
  private child?: Child;
  private sessions = new Map<string, SessionHandlers>();
  private quickExits = 0;
  private stopped = false;

  constructor(
    readonly id: string,
    private readonly deps: Deps,
  ) {
    this.name = deps.agents.nameOf(id);
    this.auth = new AuthManager({
      send: (msg) => deps.send({ ...msg, agentId: id }),
      conn: () => this.conn,
      launchSpec: () => deps.agents.launchSpec(id),
      restartAgent: () => this.restart(),
    });
  }

  addSession(sessionId: string, handlers: SessionHandlers) {
    this.sessions.set(sessionId, handlers);
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  /** Stop the process and start a fresh one (new credentials or a newer copy). */
  async restart() {
    const old = this.child;
    this.child = undefined; // so its exit handler doesn't schedule another restart
    this.reset();
    old?.kill();
    await this.deps.agents.markStopped(this.id); // a newer copy may be what starts now
    await this.start().catch((e) => console.error(`[${this.id}] restart failed:`, e));
  }

  /** Stop the process; resolves once it has exited. */
  async stop() {
    this.stopped = true;
    const old = this.child;
    this.child = undefined;
    this.reset();
    old?.kill();
    await this.deps.agents.markStopped(this.id);
    await old?.exited;
  }

  async start() {
    const spec = this.deps.agents.launchSpec(this.id);
    if (!spec) throw new Error(`${this.name} isn't installed`);
    void this.deps.agents.pruneOldVersions(this.id);
    const { cmd, args } = spec;
    console.log(`[${this.id}] starting: ${path.basename(cmd)} ${args.join(" ")}`);
    void this.deps.agents.markRunning(this.id);
    const startedAt = Date.now();
    let child: Child;
    try {
      child = Bun.spawn([cmd, ...args], {
        cwd: MODS_DIR,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // Claude Code defers MCP tools behind a ToolSearch step by default; our
        // browser tools are used in nearly every turn, so load them upfront.
        env: { ENABLE_TOOL_SEARCH: "false", ...process.env, ...spec.env },
        onExit: (_proc, code, signal) => {
          if (this.child !== child) return;
          // Back off if it keeps dying right away (broken install, bad config).
          this.quickExits = Date.now() - startedAt < 15_000 ? this.quickExits + 1 : 0;
          const delay = Math.min(2000 * 2 ** this.quickExits, 60_000);
          console.error(`[${this.id}] exited (${signal ?? code}); restarting in ${delay / 1000}s`);
          this.child = undefined;
          this.reset();
          setTimeout(() => {
            if (!this.child && !this.stopped) this.start().catch((e) => console.error(`[${this.id}] restart failed:`, e));
          }, delay);
        },
      }) as Child;
    } catch (e) {
      throw new Error(`couldn't start ${cmd}: ${(e as Error).message}`);
    }
    this.child = child;
    void logStream(this.id, child.stderr);

    const stdin = child.stdin;
    const stream = acp.ndJsonStream(
      new WritableStream<Uint8Array>({
        write(chunk) {
          stdin.write(chunk);
          stdin.flush();
        },
        close() {
          stdin.end();
        },
      }),
      child.stdout,
    );

    const app = acp
      .client({ name: "eyepatch" })
      .onNotification(acp.methods.client.session.update, ({ params }) =>
        this.sessions.get(params.sessionId)?.onUpdate(params.update),
      )
      .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => {
        const session = this.sessions.get(params.sessionId);
        return session
          ? session.onPermission(params, signal)
          : Promise.resolve({ outcome: { outcome: "cancelled" as const } });
      })
      .onNotification(acp.methods.client.auth.statusUpdate, ({ params }) => this.auth.onStatusUpdate(params));

    const conn = app.connect(stream);
    this.conn = conn;

    const init = await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        // We can run "terminal" sign-in methods (output and input relayed to
        // the side panel). The _meta flag is the older form some agents use.
        auth: { terminal: true },
        _meta: { "terminal-auth": true },
      },
      clientInfo: { name: "eyepatch", version: VERSION },
    });
    if (this.conn !== conn) return; // restarted meanwhile
    this.name = init.agentInfo?.title ?? init.agentInfo?.name ?? this.name;
    this.auth.onInitialized(init);
    const caps = init.agentCapabilities;
    this.reopen = caps?.sessionCapabilities?.resume ? "resume" : caps?.loadSession ? "load" : null;
    this.images = Boolean(caps?.promptCapabilities?.image);
    this.ready = true;
    console.log(`[${this.id}] ready: ${this.name} (protocol v${init.protocolVersion})`);
    this.deps.onReady(this);
  }

  private reset() {
    this.conn?.close();
    this.conn = undefined;
    this.ready = false;
    this.sessions.clear();
    this.deps.onReset(this);
  }
}

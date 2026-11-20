import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { LaunchSpec } from "./agents.js";
import { MODS_DIR } from "./config.js";

/**
 * Sign-in for whichever ACP agent is running, driven from the side panel.
 * site-modder doesn't manage credentials: the user's agent is expected to be
 * set up already. This only covers the case where the agent reports it's
 * signed out, using the agent's own sign-in methods.
 *
 * Everything agent-specific comes from the agent over ACP:
 * - `authMethods` from `initialize` lists how it can sign in. "terminal"
 *   methods are a command we run (its output and a line of input are relayed
 *   to the panel, e.g. to paste an OAuth code); other methods are handed to
 *   the agent with `authenticate`.
 * - `auth/status` and `auth/status_update` say whether it's signed in and as
 *   whom. Agents without these still work: we learn they
 *   need sign-in when a prompt fails with ACP's auth-required error.
 */

/** ACP's "authentication required" error code. */
export const AUTH_REQUIRED = -32000;

const stripAnsi = (s: string) =>
  s.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n");

type TerminalAuthMeta = { command?: string; args?: string[]; env?: Record<string, string>; label?: string };

function terminalMeta(m: acp.AuthMethod): TerminalAuthMeta | undefined {
  const meta = m._meta?.["terminal-auth"];
  return meta && typeof meta === "object" ? (meta as TerminalAuthMeta) : undefined;
}

function isTerminal(m: acp.AuthMethod) {
  return ("type" in m && m.type === "terminal") || Boolean(terminalMeta(m)?.command);
}

type Deps = {
  send: (msg: Record<string, unknown>) => void;
  conn: () => acp.ClientConnection | undefined;
  launchSpec: () => LaunchSpec | undefined;
  /** Restart the agent process so it picks up new credentials or env. */
  restartAgent: () => Promise<void>;
};

type SignIn = { methodId: string; name: string; output: string; child?: ChildProcess; cancelled?: boolean };

export class AuthManager {
  private agentName = "agent";
  private methods: acp.AuthMethod[] = [];
  private caps: acp.AgentAuthCapabilities | null | undefined;
  private state: acp.AuthState = "unknown";
  private accounts: acp.AuthAccount[] = [];
  private signIn: SignIn | null = null;
  private error: string | null = null;

  constructor(private readonly deps: Deps) {}

  /** Call after each `initialize` (including after a restart). */
  onInitialized(init: acp.InitializeResponse) {
    this.agentName = init.agentInfo?.title ?? init.agentInfo?.name ?? "agent";
    // Skip malformed entries (no id to sign in with, or no name to show).
    this.methods = (init.authMethods ?? []).filter((m) => m.id && m.name);
    this.caps = init.agentCapabilities?.auth;
    this.state = "unknown";
    this.accounts = [];
    void this.refresh().then(() => setTimeout(() => this.refreshIfUnknown(), 10_000));
  }

  onStatusUpdate(params: acp.AuthStatusUpdateNotification) {
    this.applyStatus(params);
    this.send();
  }

  /** A prompt failed with auth-required: the agent needs signing in. */
  markAuthRequired() {
    this.state = "unauthenticated";
    this.send();
  }

  /**
   * A prompt went through, so the agent is signed in. Agents that don't report
   * their status (e.g. Codex) only show as signed in once this happens.
   */
  markWorking() {
    if (this.state !== "unknown") return;
    this.state = "authenticated";
    this.send();
  }

  /** Claude's status check can time out while it starts; ask again later. */
  refreshIfUnknown() {
    if (this.state === "unknown" && this.caps?.status) void this.refresh();
  }

  get needsSignIn() {
    return this.state === "unauthenticated";
  }

  async refresh() {
    const conn = this.deps.conn();
    if (conn && this.caps?.status) {
      try {
        this.applyStatus(await conn.agent.request(acp.methods.agent.auth.status, {}));
      } catch (e) {
        console.warn("[auth] status failed:", (e as Error).message);
      }
    } else if (conn) {
      await this.probe(conn);
    }
    this.send();
  }

  /**
   * For agents that can't report whether they're signed in (e.g. Cursor,
   * Codex): ask for a conversation. Signed-out agents refuse with ACP's
   * auth-required error. The conversation itself is never used.
   */
  private async probe(conn: acp.ClientConnection) {
    try {
      await conn.agent.request(acp.methods.agent.session.new, { cwd: MODS_DIR, mcpServers: [] });
      this.applyStatus({ state: "authenticated" });
    } catch (e) {
      if ((e as { code?: number }).code === AUTH_REQUIRED) this.applyStatus({ state: "unauthenticated" });
    }
  }

  private applyStatus(s: { state: acp.AuthState; accounts?: acp.AuthAccount[] }) {
    this.state = s.state;
    this.accounts = s.accounts ?? [];
    if (s.state === "authenticated" || s.state === "not_required") this.error = null;
  }

  view() {
    return {
      agent: this.agentName,
      state: this.state,
      accounts: this.accounts.map((a) => ({
        label: a.label,
        name: a.name ?? null,
        email: a.email ?? null,
        organization: a.organization ?? null,
        description: a.description ?? null,
        active: a.active ?? null,
      })),
      methods: this.methods.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        kind: isTerminal(m) ? "terminal" : "agent",
      })),
      signIn: this.signIn && { methodId: this.signIn.methodId, name: this.signIn.name, output: this.signIn.output },
      error: this.error,
    };
  }

  send() {
    this.deps.send({ type: "auth", auth: this.view() });
  }

  async start(methodId: string) {
    const method = this.methods.find((m) => m.id === methodId);
    if (!method) return this.fail(`unknown method ${methodId}`);
    if (this.signIn) this.cancel();
    this.error = null;
    if (isTerminal(method)) this.runTerminal(method);
    else await this.runAgent(method);
  }

  /** Run a "terminal" method's command, relaying its output to the panel. */
  private runTerminal(method: acp.AuthMethod) {
    const meta = terminalMeta(method);
    const spec = this.deps.launchSpec();
    if (!spec) return this.fail("No agent is selected");
    const [cmd, args] = meta?.command
      ? [meta.command, meta.args ?? []]
      : [spec.cmd, [...spec.args, ...(("args" in method && method.args) || [])]];
    const env = {
      ...process.env,
      ...spec.env,
      ...(("env" in method && method.env) || {}),
      ...(meta?.env ?? {}),
    };
    console.log(`[auth] ${method.id}: ${path.basename(cmd)} ${args.slice(-4).join(" ")}`);
    const child = spawn(cmd, args, { cwd: MODS_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
    const run: SignIn = { methodId: method.id, name: method.name, output: "", child };
    this.signIn = run;
    const onData = (d: Buffer) => {
      run.output = (run.output + stripAnsi(String(d))).slice(-6000);
      if (this.signIn === run) this.send();
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("error", (e) => {
      if (this.signIn !== run) return;
      this.signIn = null;
      this.fail(`couldn't start: ${e.message}`);
    });
    child.on("exit", async (code) => {
      if (this.signIn !== run) return;
      this.signIn = null;
      if (run.cancelled) return this.send();
      if (code === 0) {
        console.log(`[auth] ${method.id} finished; restarting agent`);
        this.send();
        await this.deps.restartAgent();
      } else {
        const tail = run.output.trim().split("\n").slice(-3).join(" ");
        this.fail(`it didn't finish (exit ${code}).${tail ? ` ${tail}` : ""}`);
      }
    });
    this.send();
  }

  /** Other methods: the agent runs the sign-in itself. */
  private async runAgent(method: acp.AuthMethod) {
    const conn = this.deps.conn();
    if (!conn) return this.fail("The agent isn't running");
    const run: SignIn = { methodId: method.id, name: method.name, output: "" };
    this.signIn = run;
    this.send();
    try {
      await conn.agent.request(acp.methods.agent.authenticate, { methodId: method.id });
      if (this.signIn !== run) return; // cancelled
      this.signIn = null;
      await this.refresh();
      // It said yes, but it still refuses to work.
      if (this.state === "unauthenticated") this.fail(`${this.agentName} still isn't signed in.`);
    } catch (e) {
      if (this.signIn !== run) return;
      this.signIn = null;
      this.fail(`${(e as Error).message}`);
    }
  }

  /** A line of input for a running terminal sign-in (e.g. a pasted code). */
  input(text: string) {
    const child = this.signIn?.child;
    if (!child?.stdin?.writable) return;
    child.stdin.write(text + "\n");
    this.signIn!.output += "\n";
    this.send();
  }

  cancel() {
    const run = this.signIn;
    if (!run) return;
    run.cancelled = true;
    run.child?.kill();
    this.signIn = null;
    this.send();
  }

  private fail(message: string) {
    console.warn("[auth]", message);
    this.error = message;
    this.send();
  }
}

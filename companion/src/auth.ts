import { spawn, type ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { HOME, MODS_DIR } from "./config.js";

/**
 * Sign-in for whichever ACP agent is running, driven from the side panel.
 *
 * Everything agent-specific comes from the agent over ACP:
 * - `authMethods` from `initialize` lists how it can sign in. "terminal"
 *   methods are a command we run (its output and a line of input are relayed
 *   to the panel, e.g. to paste an OAuth code); other methods are handed to
 *   the agent with `authenticate`.
 * - `auth/status` and `auth/status_update` say whether it's signed in and as
 *   whom; `logout` signs out. Agents without these still work: we learn they
 *   need sign-in when a prompt fails with ACP's auth-required error.
 *
 * The one piece of agent-specific knowledge here is which env var holds an
 * API key, for agents that accept one.
 */

const API_KEY_ENV: Record<string, string> = {
  "@agentclientprotocol/claude-agent-acp": "ANTHROPIC_API_KEY",
  "@zed-industries/claude-agent-acp": "ANTHROPIC_API_KEY",
  "@zed-industries/claude-code-acp": "ANTHROPIC_API_KEY",
  "@google/gemini-cli": "GEMINI_API_KEY",
  "@zed-industries/codex-acp": "OPENAI_API_KEY",
};

/** ACP's "authentication required" error code. */
export const AUTH_REQUIRED = -32000;

const SECRETS_FILE = path.join(HOME, "secrets.json");

/** Env vars (API keys) the user entered in the panel, passed to every agent we start. */
export async function loadSecretEnv(): Promise<Record<string, string>> {
  try {
    const data = JSON.parse(await fsp.readFile(SECRETS_FILE, "utf8"));
    return data && typeof data.env === "object" ? data.env : {};
  } catch {
    return {};
  }
}

async function saveSecretEnv(env: Record<string, string>) {
  await fsp.mkdir(HOME, { recursive: true });
  await fsp.writeFile(SECRETS_FILE, JSON.stringify({ env }, null, 2), { mode: 0o600 });
  await fsp.chmod(SECRETS_FILE, 0o600);
}

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
  agentCommand: () => [string, string[]];
  /** Restart the agent process so it picks up new credentials or env. */
  restartAgent: () => Promise<void>;
};

type SignIn = { methodId: string; name: string; output: string; child?: ChildProcess; cancelled?: boolean };

export class AuthManager {
  private agentId = "";
  private agentName = "agent";
  private methods: acp.AuthMethod[] = [];
  private caps: acp.AgentAuthCapabilities | null | undefined;
  private state: acp.AuthState = "unknown";
  private accounts: acp.AuthAccount[] = [];
  private signIn: SignIn | null = null;
  private error: string | null = null;
  private secretEnv: Record<string, string> = {};

  constructor(private readonly deps: Deps) {}

  async loadSecrets() {
    this.secretEnv = await loadSecretEnv();
    return this.secretEnv;
  }

  /** Call after each `initialize` (including after a restart). */
  onInitialized(init: acp.InitializeResponse) {
    this.agentId = init.agentInfo?.name ?? "";
    this.agentName = init.agentInfo?.title ?? init.agentInfo?.name ?? "agent";
    this.methods = init.authMethods ?? [];
    this.caps = init.agentCapabilities?.auth;
    this.state = "unknown";
    this.accounts = [];
    void this.refresh();
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
    }
    this.send();
  }

  private applyStatus(s: { state: acp.AuthState; accounts?: acp.AuthAccount[] }) {
    this.state = s.state;
    this.accounts = s.accounts ?? [];
    if (s.state === "authenticated" || s.state === "not_required") this.error = null;
  }

  private apiKeyEnv() {
    return API_KEY_ENV[this.agentId];
  }

  view() {
    const envVar = this.apiKeyEnv();
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
      canLogout: Boolean(this.caps?.logout),
      apiKey: envVar ? { envVar, set: Boolean(this.secretEnv[envVar]) } : null,
      signIn: this.signIn && { methodId: this.signIn.methodId, name: this.signIn.name, output: this.signIn.output },
      error: this.error,
    };
  }

  send() {
    this.deps.send({ type: "auth", auth: this.view() });
  }

  async start(methodId: string) {
    const method = this.methods.find((m) => m.id === methodId);
    if (!method) return this.fail(`Unknown sign-in method ${methodId}`);
    if (this.signIn) this.cancel();
    this.error = null;
    if (isTerminal(method)) this.runTerminal(method);
    else await this.runAgent(method);
  }

  /** Run a "terminal" method's command, relaying its output to the panel. */
  private runTerminal(method: acp.AuthMethod) {
    const meta = terminalMeta(method);
    const [agentCmd, agentArgs] = this.deps.agentCommand();
    const [cmd, args] = meta?.command
      ? [meta.command, meta.args ?? []]
      : [agentCmd, [...agentArgs, ...(("args" in method && method.args) || [])]];
    const env = {
      ...process.env,
      ...this.secretEnv,
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
      this.fail(`Couldn't start sign-in: ${e.message}`);
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
        this.fail(`Sign-in didn't finish (exit ${code}).${tail ? ` ${tail}` : ""}`);
      }
    });
    this.send();
  }

  /** Other methods: the agent runs the sign-in itself. */
  private async runAgent(method: acp.AuthMethod) {
    const conn = this.deps.conn();
    if (!conn) return this.fail("The agent isn't running");
    this.signIn = { methodId: method.id, name: method.name, output: "" };
    this.send();
    try {
      await conn.agent.request(acp.methods.agent.authenticate, { methodId: method.id });
      this.signIn = null;
      if (!this.caps?.status) this.state = "authenticated";
      await this.refresh();
    } catch (e) {
      this.signIn = null;
      this.fail(`Sign-in failed: ${(e as Error).message}`);
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

  async logout() {
    const conn = this.deps.conn();
    if (!conn || !this.caps?.logout) return;
    try {
      await conn.agent.request(acp.methods.agent.logout, {});
    } catch (e) {
      return this.fail(`Sign-out failed: ${(e as Error).message}`);
    }
    await this.refresh();
  }

  /** Save (or with null, remove) an API key, then restart the agent with it. */
  async setApiKey(key: string | null) {
    const envVar = this.apiKeyEnv();
    if (!envVar) return this.fail("This agent doesn't take an API key here");
    const next = { ...(await loadSecretEnv()) };
    if (key?.trim()) next[envVar] = key.trim();
    else delete next[envVar];
    await saveSecretEnv(next);
    this.secretEnv = next;
    this.error = null;
    this.send();
    await this.deps.restartAgent();
  }

  private fail(message: string) {
    console.warn("[auth]", message);
    this.error = message;
    this.send();
  }
}

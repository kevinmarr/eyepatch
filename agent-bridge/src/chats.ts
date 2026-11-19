import fs from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { AgentProcess } from "./agent-process.js";
import type { AgentManager } from "./agents.js";
import { AUTH_REQUIRED } from "./auth.js";
import { createBrowserTools } from "./browser-tools.js";
import { HOME, MODS_DIR } from "./config.js";
import type { ExtensionSocket, FromExtension, PageInfo } from "./extension-socket.js";
import { modApplies } from "./match.js";
import { loadMods, type Mod } from "./mods.js";

/**
 * One chat per browser tab. Each chat has its own agent (tabs can use
 * different agents) and its own ACP session; tabs using the same agent share
 * one agent process. Chats are saved to ~/.site-modder/sessions so they can
 * be restored later.
 */

const SESSIONS_DIR = path.join(HOME, "sessions");
const MAX_EVENTS = 2000;
/** How long after an agent edits a mod its tab counts as the one that changed it. */
const EDIT_ATTRIBUTION_MS = 120_000;

const READ_ONLY_BROWSER_TOOLS = new Set(
  ["get_tab", "get_page_content", "query_selector_all", "screenshot", "get_console_logs"].map(
    (t) => `mcp__browser__${t}`,
  ),
);

/** Something shown in a tab's chat, replayed when its side panel opens. */
type ChatEvent = Record<string, unknown> & { type: string };

type Chat = {
  tabId: number;
  agentId: string | null;
  sessionId?: string;
  sessionStarting?: Promise<string>;
  busy: boolean;
  configOptions: acp.SessionConfigOption[];
  browserServer?: acp.McpServerRegistration;
  events: ChatEvent[];
  /** Mods this chat's agent edited, and when (for deciding which tabs to reload). */
  edits: Map<string, number>;
  createdAt: number;
  url?: string;
};

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Context prepended to each user message: the tab, and the mods that apply
 * to it (matched the same way Chrome does), so the agent knows what's already
 * running without searching.
 */
async function pageContext(page: PageInfo) {
  if (!page.url) return "";
  const lines = [`<active-tab url="${attr(page.url)}" title="${attr(page.title ?? "")}" />`];
  let mods: Mod[] = [];
  try {
    mods = (await loadMods()).filter((m) => m.matches.length && modApplies(m, page.url!));
  } catch (e) {
    console.error("[chats] could not load mods for context:", e);
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

/** The mod a file path belongs to, if it's inside the mods dir. */
function modIdOf(file: unknown): string | null {
  if (typeof file !== "string") return null;
  const rel = path.relative(MODS_DIR, path.resolve(MODS_DIR, file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [id, ...rest] = rel.split(path.sep);
  return rest.length ? id : null;
}

/** Merge streamed chunks so saved history stays small. */
function compact(events: ChatEvent[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    const u = e.type === "session_update" ? (e.update as { sessionUpdate: string; content?: { type: string; text?: string } }) : null;
    const pu = prev?.type === "session_update" ? (prev.update as typeof u) : null;
    if (u && pu && u.sessionUpdate === pu!.sessionUpdate && /_chunk$/.test(u.sessionUpdate) && u.content?.type === "text" && pu!.content?.type === "text") {
      out[out.length - 1] = {
        ...prev,
        update: { ...pu, content: { ...pu!.content, text: (pu!.content.text ?? "") + (u.content.text ?? "") } },
      };
    } else {
      out.push(e);
    }
  }
  return out;
}

export class Chats {
  private chats = new Map<number, Chat>();
  private agents = new Map<string, AgentProcess>();
  private permissions = new Map<string, (optionId: string | null) => void>();
  private permissionSeq = 0;

  constructor(
    private readonly extension: ExtensionSocket,
    private readonly catalog: AgentManager,
  ) {
    extension.on((msg) => this.onMessage(msg));
    extension.onConnect(() => {
      for (const agent of this.agents.values()) agent.auth.send();
    });
    // A newer copy of an agent was installed: switch to it once its chats are idle.
    catalog.onUpdated((id) => this.restartWhenIdle(id));
    void fs.mkdir(SESSIONS_DIR, { recursive: true });
  }

  /** Mod ids → the tabs whose agent just edited them. Empty if none did (e.g. a hand edit). */
  tabsThatEdited(modIds: string[]): number[] {
    const now = Date.now();
    const tabs = new Set<number>();
    for (const chat of this.chats.values()) {
      for (const id of modIds) {
        const t = chat.edits.get(id);
        if (t && now - t < EDIT_ATTRIBUTION_MS) tabs.add(chat.tabId);
      }
    }
    return [...tabs];
  }

  // ---------- messages from the extension ----------

  private onMessage(msg: FromExtension) {
    switch (msg.type) {
      case "hello":
        this.forgetClosedTabs(msg.tabs);
        for (const agent of this.agents.values()) agent.auth.send();
        break;
      case "open_chat":
        void this.open(msg.tabId);
        break;
      case "close_chat":
        void this.close(msg.tabId);
        break;
      case "prompt":
        void this.prompt(msg.tabId, msg.text, msg.page);
        break;
      case "cancel":
        void this.cancel(msg.tabId);
        break;
      case "new_session":
        void this.newSession(msg.tabId);
        break;
      case "permission_response":
        this.permissions.get(msg.id)?.(msg.optionId);
        break;
      case "set_model":
        void this.setModel(msg.tabId, msg.value);
        break;
      case "agent_select":
        void this.setAgent(msg.tabId, msg.id);
        break;
      case "agents_refresh":
        void this.catalog.refresh();
        break;
      case "auth_start":
        void this.agents.get(msg.agentId)?.auth.start(msg.methodId);
        break;
      case "auth_input":
        this.agents.get(msg.agentId)?.auth.input(msg.text);
        break;
      case "auth_cancel":
        this.agents.get(msg.agentId)?.auth.cancel();
        break;
      case "auth_recheck": {
        // The user may have signed in outside site-modder; a fresh agent
        // process re-reads its credentials and reports status again.
        const agent = this.agents.get(msg.agentId);
        if (agent && !this.busyOn(agent.id)) void agent.restart();
        break;
      }
      case "auth_logout": {
        const agent = this.agents.get(msg.agentId);
        if (!agent) break;
        void Promise.all(this.chatsOn(agent.id).map((c) => this.newSession(c.tabId))).then(() => agent.auth.logout());
        break;
      }
    }
  }

  // ---------- chats ----------

  private chat(tabId: number): Chat {
    let chat = this.chats.get(tabId);
    if (!chat) {
      chat = {
        tabId,
        agentId: this.catalog.defaultId,
        busy: false,
        configOptions: [],
        events: [],
        edits: new Map(),
        createdAt: Date.now(),
      };
      this.chats.set(tabId, chat);
    }
    return chat;
  }

  private chatsOn(agentId: string) {
    return [...this.chats.values()].filter((c) => c.agentId === agentId);
  }

  private busyOn(agentId: string) {
    return this.chatsOn(agentId).some((c) => c.busy);
  }

  /** A side panel opened for this tab: send its state and history, and get its agent going. */
  private async open(tabId: number) {
    const chat = this.chat(tabId);
    // A tab opened before any agent was installed picks up the default once there is one.
    if (!chat.agentId && this.catalog.defaultId) chat.agentId = this.catalog.defaultId;
    this.extension.send({ type: "transcript", tabId, events: chat.events });
    this.sendChat(chat);
    const agent = this.agentFor(chat);
    if (agent) {
      agent.auth.send();
      // Start the conversation now so the agent's models show before the first message.
      if (agent.ready) void this.ensureSession(chat).catch(() => {});
    }
  }

  /** The tab closed: end its session but keep its history. */
  private async close(tabId: number) {
    const chat = this.chats.get(tabId);
    if (!chat) return;
    await this.cancel(tabId);
    await this.endSession(chat);
    this.chats.delete(tabId);
    this.stopUnusedAgents();
  }

  /** After a browser restart, tab ids are new; drop chats for tabs that no longer exist. */
  private forgetClosedTabs(open: number[] | undefined) {
    if (!open) return;
    for (const tabId of [...this.chats.keys()]) if (!open.includes(tabId)) void this.close(tabId);
  }

  private async newSession(tabId: number) {
    const chat = this.chats.get(tabId);
    if (!chat) return;
    await this.cancel(tabId);
    await this.endSession(chat);
    this.extension.send({ type: "transcript", tabId, events: [] });
    this.sendChat(chat);
    const agent = this.agentFor(chat);
    if (agent?.ready) void this.ensureSession(chat).catch(() => {});
  }

  /** Use another agent in this tab (installing it if needed). Starts a new conversation. */
  private async setAgent(tabId: number, agentId: string) {
    const chat = this.chat(tabId);
    if (chat.busy) return;
    if (!(await this.catalog.choose(agentId))) return;
    if (chat.agentId === agentId && chat.sessionId) return;
    await this.endSession(chat);
    chat.agentId = agentId;
    this.extension.send({ type: "transcript", tabId, events: [] });
    this.sendChat(chat);
    const agent = this.agentFor(chat)!;
    agent.auth.send();
    if (agent.ready) void this.ensureSession(chat).catch(() => {});
    this.stopUnusedAgents();
  }

  /** Save the chat's history and forget its session (the agent keeps its own copy). */
  private async endSession(chat: Chat) {
    await this.saveHistory(chat);
    if (chat.sessionId) this.agents.get(chat.agentId ?? "")?.removeSession(chat.sessionId);
    void chat.browserServer?.dispose();
    chat.browserServer = undefined;
    chat.sessionId = undefined;
    chat.sessionStarting = undefined;
    chat.configOptions = [];
    chat.events = [];
    chat.edits.clear();
    chat.createdAt = Date.now();
  }

  private sendChat(chat: Chat) {
    const agent = chat.agentId ? this.agents.get(chat.agentId) : undefined;
    this.extension.send({
      type: "chat",
      tabId: chat.tabId,
      chat: {
        agentId: chat.agentId,
        agent: agent?.name ?? (chat.agentId ? this.catalog.nameOf(chat.agentId) : null),
        ready: Boolean(agent?.ready),
        busy: chat.busy,
        sessionId: chat.sessionId ?? null,
        browserTools: agent?.ready ? agent.supportsAcpMcp : null,
        model: this.modelView(chat),
      },
    });
  }

  /** Record something for the tab's chat and send it to the extension. */
  private emit(chat: Chat, event: ChatEvent) {
    chat.events.push(event);
    if (chat.events.length > MAX_EVENTS) chat.events = chat.events.slice(-MAX_EVENTS);
    this.extension.send({ ...event, tabId: chat.tabId });
  }

  private error(chat: Chat, message: string) {
    this.emit(chat, { type: "error", message });
  }

  // ---------- agents ----------

  /** The chat's agent process, started if it isn't running. */
  private agentFor(chat: Chat): AgentProcess | undefined {
    const id = chat.agentId;
    if (!id || !this.catalog.isInstalled(id)) return undefined;
    let agent = this.agents.get(id);
    if (!agent) {
      agent = new AgentProcess(id, {
        agents: this.catalog,
        send: (msg) => this.extension.send(msg),
        onReady: (a) => {
          for (const c of this.chatsOn(a.id)) {
            this.sendChat(c);
            void this.ensureSession(c).catch(() => {});
          }
        },
        onReset: (a) => {
          for (const c of this.chatsOn(a.id)) {
            this.cancelPermissions(c);
            void c.browserServer?.dispose();
            c.browserServer = undefined;
            c.sessionId = undefined;
            c.sessionStarting = undefined;
            c.busy = false;
            c.configOptions = [];
            this.sendChat(c);
          }
        },
      });
      this.agents.set(id, agent);
      agent.start().catch((e) => console.error(`[${id}] failed to start:`, e));
    }
    return agent;
  }

  /** Stop agent processes no tab uses anymore. */
  private stopUnusedAgents() {
    for (const [id, agent] of this.agents) {
      if (!this.chatsOn(id).length) {
        agent.stop();
        this.agents.delete(id);
      }
    }
  }

  private pendingRestarts = new Set<string>();

  private restartWhenIdle(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent) return; // not running; the new copy is used next time it starts
    if (this.busyOn(agentId)) this.pendingRestarts.add(agentId);
    else void agent.restart();
  }

  // ---------- sessions ----------

  /** Create the chat's session once, even if several callers ask at the same time. */
  private ensureSession(chat: Chat): Promise<string> {
    if (chat.sessionId) return Promise.resolve(chat.sessionId);
    chat.sessionStarting ??= this.createSession(chat).finally(() => (chat.sessionStarting = undefined));
    return chat.sessionStarting;
  }

  private async createSession(chat: Chat): Promise<string> {
    const agent = this.agentFor(chat);
    const conn = agent?.conn;
    if (!agent?.ready || !conn) throw new Error("The agent is still starting. Try again in a moment.");
    const agentId = agent.id;

    // Browser tools for this tab only, served over this agent's ACP connection.
    const tools = createBrowserTools((method, args, options) =>
      this.extension.callWithWarning(method, { ...(args as object), tabId: chat.tabId }, options),
    );
    const server = agent.supportsAcpMcp ? agent.mcp.registerServer(conn.agent, { name: "browser", handler: tools.handler }) : undefined;

    let res: acp.NewSessionResponse;
    try {
      res = await conn.agent.request(acp.methods.agent.session.new, {
        cwd: MODS_DIR,
        mcpServers: server ? [server.declaration] : [],
      });
    } catch (e) {
      void server?.dispose();
      if ((e as { code?: number }).code === AUTH_REQUIRED) agent.auth.markAuthRequired();
      throw e;
    }
    if (agent.conn !== conn || chat.agentId !== agentId) {
      void server?.dispose();
      throw new Error("The agent restarted");
    }
    chat.sessionId = res.sessionId;
    chat.browserServer = server;
    chat.configOptions = res.configOptions ?? [];
    agent.addSession(res.sessionId, {
      onUpdate: (update) => this.onUpdate(chat, update),
      onPermission: (params, signal) => this.requestPermission(chat, params, signal),
    });

    // Mods live in their own directory and apply live, so don't prompt for
    // every file edit. Commands and other tools still ask in the side panel.
    const acceptEdits = res.modes?.availableModes.find((m) => m.id === "acceptEdits");
    if (acceptEdits) {
      await conn.agent.request(acp.methods.agent.session.setMode, { sessionId: res.sessionId, modeId: acceptEdits.id });
    }
    // Use the model last picked for this agent.
    const preferred = this.catalog.preferredModel(agentId);
    const opt = this.modelOption(chat);
    if (opt && preferred && preferred !== opt.currentValue && this.flatOptions(opt).some((o) => o.value === preferred)) {
      try {
        const set = await conn.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: res.sessionId,
          configId: opt.id,
          value: preferred,
        });
        chat.configOptions = set.configOptions;
      } catch (e) {
        console.warn(`[${agentId}] couldn't restore the model:`, (e as Error).message);
      }
    }
    this.sendChat(chat);
    return res.sessionId;
  }

  private onUpdate(chat: Chat, update: acp.SessionUpdate) {
    if (update.sessionUpdate === "config_option_update") {
      chat.configOptions = update.configOptions;
      this.sendChat(chat);
      return;
    }
    // Remember which mods this chat's agent edits, so only its tab reloads.
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const files = [
        ...(update.locations ?? []).map((l) => l.path),
        (update.rawInput as { file_path?: unknown } | null | undefined)?.file_path,
      ];
      for (const f of files) {
        const id = modIdOf(f);
        if (id) chat.edits.set(id, Date.now());
      }
    }
    this.emit(chat, { type: "session_update", update });
  }

  private async prompt(tabId: number, text: string, page?: PageInfo) {
    const chat = this.chat(tabId);
    const agent = this.agentFor(chat);
    if (!agent) return this.error(chat, "Choose an agent first.");
    if (!agent.ready) return this.error(chat, "The agent is still starting. Try again in a moment.");
    if (chat.busy) return this.error(chat, "The agent is busy; stop it or wait for it to finish.");
    if (agent.auth.needsSignIn) return this.error(chat, `Sign in to ${agent.name} first.`);

    chat.busy = true;
    chat.url ??= page?.url;
    this.emit(chat, { type: "user_message", text, url: page?.url });
    this.sendChat(chat);
    try {
      const sessionId = await this.ensureSession(chat);
      const context = page ? await pageContext(page) : "";
      const res = await agent.conn!.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: context + text }],
      });
      this.emit(chat, { type: "turn_end", stopReason: res.stopReason });
    } catch (e) {
      console.error(`[${agent.id}] prompt failed:`, e);
      const authRequired = (e as { code?: number }).code === AUTH_REQUIRED;
      if (authRequired) agent.auth.markAuthRequired();
      this.error(chat, authRequired ? `Sign in to ${agent.name} to continue.` : String((e as Error).message ?? e));
      this.emit(chat, { type: "turn_end", stopReason: "error" });
    } finally {
      chat.busy = false;
      this.sendChat(chat);
      agent.auth.refreshIfUnknown();
      void this.saveHistory(chat);
      if (this.pendingRestarts.has(agent.id) && !this.busyOn(agent.id)) {
        this.pendingRestarts.delete(agent.id);
        void agent.restart();
      }
    }
  }

  private async cancel(tabId: number) {
    const chat = this.chats.get(tabId);
    if (!chat) return;
    this.cancelPermissions(chat);
    const agent = chat.agentId ? this.agents.get(chat.agentId) : undefined;
    if (chat.sessionId && chat.busy && agent?.conn) {
      await agent.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: chat.sessionId });
    }
  }

  // ---------- model ----------

  private modelOption(chat: Chat) {
    const opt = chat.configOptions.find((o) => o.category === "model" && o.type === "select");
    return opt?.type === "select" ? opt : undefined;
  }

  private flatOptions(opt: NonNullable<ReturnType<Chats["modelOption"]>>) {
    return opt.options.flatMap((o) => ("group" in o ? o.options : [o]));
  }

  private modelView(chat: Chat) {
    const opt = this.modelOption(chat);
    if (!opt) return null;
    return {
      current: opt.currentValue,
      options: this.flatOptions(opt).map((o) => ({ value: o.value, name: o.name, description: o.description ?? null })),
    };
  }

  private async setModel(tabId: number, value: string) {
    const chat = this.chat(tabId);
    try {
      const sessionId = await this.ensureSession(chat);
      const opt = this.modelOption(chat);
      const agent = this.agentFor(chat);
      if (!opt || !agent?.conn) return;
      const res = await agent.conn.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: opt.id,
        value,
      });
      chat.configOptions = res.configOptions;
      await this.catalog.setPreferredModel(agent.id, value);
    } catch (e) {
      this.error(chat, `Couldn't change the model: ${(e as Error).message}`);
    }
    this.sendChat(chat);
  }

  // ---------- permissions ----------

  private requestPermission(
    chat: Chat,
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
        if (!this.permissions.has(id)) return;
        this.permissions.delete(id);
        this.emit(chat, { type: "permission_resolved", id });
        resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
      };
      (done as { tabId?: number }).tabId = chat.tabId;
      this.permissions.set(id, done);
      signal.addEventListener("abort", () => done(null), { once: true });
      this.emit(chat, { type: "permission_request", id, toolCall: params.toolCall, options: params.options });
    });
  }

  private cancelPermissions(chat: Chat) {
    for (const done of [...this.permissions.values()]) {
      if ((done as { tabId?: number }).tabId === chat.tabId) done(null);
    }
  }

  // ---------- history ----------

  /** Save a chat to ~/.site-modder/sessions/<session id>.json (for a future history menu). */
  private async saveHistory(chat: Chat) {
    if (!chat.sessionId || !chat.events.some((e) => e.type === "user_message")) return;
    const first = chat.events.find((e) => e.type === "user_message") as { text?: string } | undefined;
    const record = {
      sessionId: chat.sessionId,
      agentId: chat.agentId,
      agent: chat.agentId ? (this.agents.get(chat.agentId)?.name ?? this.catalog.nameOf(chat.agentId)) : null,
      title: (first?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      url: chat.url ?? null,
      createdAt: new Date(chat.createdAt).toISOString(),
      updatedAt: new Date().toISOString(),
      events: compact(chat.events),
    };
    const file = path.join(SESSIONS_DIR, `${chat.sessionId.replace(/[^\w.-]/g, "_")}.json`);
    await fs.writeFile(file, JSON.stringify(record)).catch((e) => console.warn("[chats] couldn't save history:", e.message));
  }
}

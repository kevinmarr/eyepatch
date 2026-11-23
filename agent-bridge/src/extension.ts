import type { Connection, Message } from "./native-messaging.ts";

/** Messages the extension sends to Agent Bridge. */
export type FromExtension =
  | { type: "hello"; extensionVersion?: string; tabs?: number[] }
  | { type: "open_chat"; tabId: number }
  | { type: "close_chat"; tabId: number }
  | { type: "prompt"; tabId: number; text: string; images?: PromptImage[]; elements?: PickedElement[]; page?: PageInfo }
  | { type: "cancel"; tabId: number }
  | { type: "new_session"; tabId: number }
  | { type: "permission_response"; id: string; optionId: string | null }
  | { type: "tool_result"; id: string; result?: unknown; error?: string; warning?: string }
  | { type: "set_model"; tabId: number; value: string }
  | { type: "set_effort"; tabId: number; value: string }
  | { type: "set_mode"; tabId: number; value: string }
  | { type: "agent_select"; tabId: number; id: string }
  | { type: "agent_install"; id: string }
  | { type: "agent_remove"; id: string }
  | { type: "options_open" }
  | { type: "options_close" }
  | { type: "agents_refresh" }
  | { type: "sync_mods" }
  | { type: "mod_set_enabled"; id: string; enabled: boolean }
  | { type: "mod_delete"; id: string }
  | { type: "mod_reveal"; id: string }
  | { type: "mod_import"; requestId: string; fileName: string; content: string }
  | { type: "history_list"; tabId: number }
  | { type: "history_restore"; tabId: number; sessionId: string }
  | { type: "auth_start"; agentId: string; methodId: string }
  | { type: "auth_input"; agentId: string; text: string }
  | { type: "auth_cancel"; agentId: string }
  | { type: "auth_recheck"; agentId: string };

export type PageInfo = { tabId?: number; url?: string; title?: string };
/** An image attached to a message: base64 data for the agent, and a small thumbnail (a data URL) for the chat. */
export type PromptImage = { mimeType: string; data: string; thumb?: string };
/** An element the user picked on the page to point the agent at. */
export type PickedElement = { selector: string; label: string; html?: string; text?: string };

type CallOptions = { timeoutMs?: number; skipBarrier?: boolean };

type Pending = {
  resolve: (v: { result: unknown; warning?: string }) => void;
  reject: (e: Error) => void;
  timer?: Timer;
};

/**
 * Agent Bridge's link to the extension's service worker. Normally there's one
 * connection for the life of the process (Chrome started us over native
 * messaging). In dev mode, connections come and go as the extension reloads,
 * and a new one replaces the old.
 */
export class Extension {
  private conn: Connection | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private listeners: Array<(msg: FromExtension) => void> = [];
  private connectListeners: Array<() => void> = [];
  private barrier: Promise<unknown> = Promise.resolve();

  /** Use a new connection; `connection` receives this link's message handler. */
  attach(connection: (onMessage: (msg: Message) => void) => Connection): Connection {
    const conn = connection((msg) => this.conn === conn && this.handle(msg as FromExtension));
    this.detach();
    this.conn = conn;
    console.log("[extension] connected");
    void conn.closed.then(() => {
      if (this.conn !== conn) return;
      console.log("[extension] disconnected");
      this.detach();
    });
    for (const l of this.connectListeners) l();
    return conn;
  }

  private detach() {
    this.conn = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Extension disconnected"));
      this.pending.delete(id);
    }
  }

  get connected() {
    return this.conn !== null;
  }

  send(msg: Message) {
    this.conn?.send(msg);
  }

  /**
   * Hold browser calls until `work` settles. Used while mods are being applied
   * (and tabs reloaded) so the agent never inspects a stale page.
   */
  holdCallsUntil(work: Promise<unknown>) {
    const prev = this.barrier;
    this.barrier = Promise.allSettled([prev, work]);
  }

  /** Ask the extension to do something in the browser and await the result. */
  async call<T = unknown>(method: string, params: unknown = {}, options: CallOptions = {}): Promise<T> {
    return (await this.callWithWarning<T>(method, params, options)).result;
  }

  /** Like call(), plus any warning the extension attached (e.g. the tab navigated). */
  async callWithWarning<T = unknown>(
    method: string,
    params: unknown = {},
    { timeoutMs = 30_000, skipBarrier = false }: CallOptions = {},
  ): Promise<{ result: T; warning?: string }> {
    if (!skipBarrier) await this.barrier;
    if (!this.connected) throw new Error("Extension is not connected");
    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      // Infinity = wait as long as it takes (e.g. for the user to switch tabs).
      // The call still fails if the extension disconnects.
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Browser call ${method} timed out`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject, timer });
      this.send({ type: "tool_call", id, method, params });
    });
  }

  on(listener: (msg: FromExtension) => void) {
    this.listeners.push(listener);
  }

  onConnect(listener: () => void) {
    this.connectListeners.push(listener);
  }

  private handle(msg: FromExtension) {
    if (msg.type === "tool_result") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve({ result: msg.result, warning: msg.warning });
      return;
    }
    for (const l of this.listeners) l(msg);
  }
}

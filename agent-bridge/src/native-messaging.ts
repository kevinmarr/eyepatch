/**
 * Chrome's native messaging wire format: each message is a 32-bit length in
 * native byte order (little-endian on every platform we run on) followed by
 * that many bytes of UTF-8 JSON.
 *
 * Chrome refuses messages over 1 MB from the host, so larger ones are sent as
 * a series of `{ type: "chunk", id, last, data }` messages, each carrying a
 * slice of the JSON text, which the extension joins and parses
 * (extension/background.js). Messages the other way can be up to 64 MB.
 */

/** Characters of JSON per chunk: even if every one became 3 bytes of UTF-8 plus escaping, it stays under 1 MB. */
export const CHUNK_CHARS = 250_000;

export type Message = Record<string, unknown>;

/** Frame one message. */
export function encode(msg: unknown): Uint8Array {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

let chunkSeq = 0;

/** Frame a message to Chrome, split into chunks if it's too big for one. */
export function encodeForChrome(msg: unknown): Uint8Array[] {
  const json = JSON.stringify(msg);
  if (json.length <= CHUNK_CHARS) return [encode(msg)];
  const id = `k${++chunkSeq}`;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < json.length; i += CHUNK_CHARS) {
    frames.push(encode({ type: "chunk", id, last: i + CHUNK_CHARS >= json.length, data: json.slice(i, i + CHUNK_CHARS) }));
  }
  return frames;
}

/** Turns a byte stream back into messages. */
export class Decoder {
  private buf = Buffer.alloc(0);

  /** Add bytes; returns the messages completed by them. */
  push(chunk: Uint8Array): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(body));
      } catch {
        // Not JSON; skip it.
      }
    }
    return out;
  }
}

/** Joins chunked messages (the counterpart of encodeForChrome, for tests and tools). */
export class Unchunker {
  private parts = new Map<string, string[]>();

  /** The complete message, or null while a chunked one is still arriving. */
  take(msg: unknown): Message | null {
    const m = msg as Message;
    if (m?.type !== "chunk") return m;
    const id = String(m.id);
    const parts = this.parts.get(id) ?? [];
    parts.push(String(m.data));
    if (!m.last) {
      this.parts.set(id, parts);
      return null;
    }
    this.parts.delete(id);
    return JSON.parse(parts.join(""));
  }
}

/**
 * A connection to the extension: messages in, messages out. Over stdio when
 * Chrome started us, or over a local socket in dev mode (where Chrome starts
 * a shim that pipes its stdio to the socket).
 */
export interface Connection {
  send(msg: Message): void;
  /** Resolves when the other end goes away. */
  readonly closed: Promise<void>;
}

/** A connection over a readable byte stream and a byte sink. */
export function connect(
  input: AsyncIterable<Uint8Array>,
  write: (bytes: Uint8Array) => void,
  onMessage: (msg: Message) => void,
): Connection {
  const decoder = new Decoder();
  let open = true;
  const closed = (async () => {
    try {
      for await (const chunk of input) for (const msg of decoder.push(chunk)) onMessage(msg as Message);
    } catch {
      // The pipe broke; same as closing.
    }
    open = false;
  })();
  return {
    send(msg) {
      if (!open) return;
      try {
        for (const frame of encodeForChrome(msg)) write(frame);
      } catch {
        open = false;
      }
    },
    closed,
  };
}

/** The connection to Chrome over this process's stdin and stdout. */
export function connectStdio(onMessage: (msg: Message) => void): Connection {
  const out = Bun.stdout.writer();
  return connect(
    Bun.stdin.stream(),
    (bytes) => {
      out.write(bytes);
      out.flush();
    },
    onMessage,
  );
}

import { expect, test } from "bun:test";
import { CHUNK_CHARS, Decoder, encode, encodeForChrome, Unchunker } from "../src/native-messaging.ts";

test("a message survives being split at any byte", () => {
  const msg = { type: "hi", text: "héllo ✓ 👋", n: [1, 2, 3] };
  const bytes = encode(msg);
  expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)).toBe(bytes.length - 4);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const d = new Decoder();
    expect([...d.push(bytes.subarray(0, cut)), ...d.push(bytes.subarray(cut))]).toEqual([msg]);
  }
});

test("several messages in one read", () => {
  const d = new Decoder();
  const both = Buffer.concat([encode({ a: 1 }), encode({ b: 2 })]);
  expect(d.push(both)).toEqual([{ a: 1 }, { b: 2 }]);
});

test("big messages are chunked under Chrome's 1 MB limit and rejoined", () => {
  // Worst case for size: multi-byte characters and characters JSON escapes.
  const msg = { type: "apply_mods", body: "é\"✓".repeat(400_000), more: "x".repeat(CHUNK_CHARS) };
  const frames = encodeForChrome(msg);
  expect(frames.length).toBeGreaterThan(1);
  for (const f of frames) expect(f.length).toBeLessThan(1024 * 1024);
  const d = new Decoder();
  const u = new Unchunker();
  const got = frames.flatMap((f) => d.push(f)).map((m) => u.take(m)).filter(Boolean);
  expect(got).toEqual([msg]);
});

test("small messages aren't chunked", () => {
  expect(encodeForChrome({ type: "ping" })).toHaveLength(1);
});

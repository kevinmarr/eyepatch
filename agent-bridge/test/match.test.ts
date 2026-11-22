import { expect, test } from "bun:test";
import { matchesPattern as m, modApplies } from "../src/match.ts";

const cases: [string, string, boolean][] = [
  ["https://substack.com/*", "https://substack.com/home/post/p-1", true],
  ["https://*.substack.com/*", "https://simplealpha.substack.com/p/x?utm=1", true],
  ["https://*.substack.com/*", "https://substack.com/", true],
  ["https://*.substack.com/*", "https://notsubstack.com/", false],
  ["https://*.substack.com/*", "https://substack.com.evil.io/", false],
  ["*://example.com/*", "http://example.com/a", true],
  ["*://example.com/*", "file:///example.com/a", false],
  ["https://example.com/foo*", "https://example.com/foobar", true],
  ["https://example.com/foo*", "https://example.com/bar", false],
  ["https://example.com/*bar", "https://example.com/x?y=bar", true],
  ["http://localhost/*", "http://localhost:3000/app", true],
  ["<all_urls>", "chrome://extensions", false],
  ["<all_urls>", "https://a.b/c", true],
  ["https://example.com/a.b", "https://example.com/aXb", false],
];
test.each(cases)("%s matches %s: %p", (pattern, url, want) => {
  expect(m(pattern, url)).toBe(want);
});

test("excludeMatches", () => {
  expect(modApplies({ matches: ["https://*.substack.com/*"], excludeMatches: ["https://*.substack.com/account*"] }, "https://x.substack.com/account/settings")).toBe(false);
});

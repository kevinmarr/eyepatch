// Run with: npx tsx scripts/test-match.ts
import { matchesPattern as m, modApplies } from "../src/match.js";

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
let fail = 0;
for (const [p, u, want] of cases) {
  const got = m(p, u);
  if (got !== want) {
    fail++;
    console.log("FAIL", p, u, "got", got);
  }
}
if (modApplies({ matches: ["https://*.substack.com/*"], excludeMatches: ["https://*.substack.com/account*"] }, "https://x.substack.com/account/settings")) {
  fail++;
  console.log("FAIL excludeMatches");
}
console.log(fail ? `${fail} failed` : `all ${cases.length + 1} passed`);
process.exitCode = fail ? 1 : 0;

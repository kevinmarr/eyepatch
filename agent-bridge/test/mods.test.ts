import { test } from "bun:test";
import assert from "node:assert/strict";
import { modApplies } from "../src/match.ts";
import { parseUserCss, parseUserScript, splitSections } from "../src/modfile.ts";

const userscript = (header: string, body = "console.log(1);") =>
  `// ==UserScript==\n${header.trim().split("\n").map((l) => `// ${l.trim()}`).join("\n")}\n// ==/UserScript==\n\n${body}\n`;

// ---------- userscripts ----------

test("plain @match script", () => {
  const m = parseUserScript("a.user.js", userscript(`
    @name  Hide sidebar
    @description  Hides it
    @version 1.2
    @match https://github.com/*
    @exclude-match https://github.com/settings/*
    @grant GM_addStyle
    @noframes
  `));
  assert.equal(m.error, undefined);
  assert.equal(m.name, "Hide sidebar");
  assert.equal(m.description, "Hides it");
  assert.equal(m.version, "1.2");
  assert.deepEqual(m.matches, ["https://github.com/*"]);
  assert.deepEqual(m.excludeMatches, ["https://github.com/settings/*"]);
  assert.equal(m.filter, undefined);
  assert.deepEqual(m.grants, ["addStyle"]);
  assert.equal(m.world, "isolated");
  assert.equal(m.allFrames, false);
  assert.equal(m.runAt, "document_idle");
  assert.deepEqual(m.sites, ["github.com"]);
});

test("no grants runs in the page, like Tampermonkey", () => {
  const m = parseUserScript("a.user.js", userscript(`@match https://x.com/*\n@grant none`));
  assert.equal(m.world, "main");
  assert.equal(m.allFrames, true);
  assert.equal(parseUserScript("a.user.js", userscript(`@match https://x.com/*`)).world, "main");
});

test("@inject-into and @sandbox pick the world", () => {
  assert.equal(parseUserScript("a.user.js", userscript(`@match https://x.com/*\n@grant none\n@inject-into content`)).world, "isolated");
  assert.equal(parseUserScript("a.user.js", userscript(`@match https://x.com/*\n@grant GM_addStyle\n@inject-into page`)).world, "main");
  assert.equal(parseUserScript("a.user.js", userscript(`@match https://x.com/*\n@sandbox DOM`)).world, "isolated");
});

test("GM grants in both spellings; unknown ones warn", () => {
  const m = parseUserScript("a.user.js", userscript(`
    @match https://x.com/*
    @grant GM.getValue
    @grant GM_setValue
    @grant GM.xmlHttpRequest
    @grant GM_webRequest
    @grant GM_download
    @grant GM_addStyle
    @grant GM.getResourceUrl
    @grant unsafeWindow
    @grant window.close
  `));
  assert.deepEqual(m.grants?.sort(), ["addStyle", "download", "getResourceURL", "getValue", "setValue", "xmlhttpRequest"]);
  assert.deepEqual(m.warnings, ["unsupported @grant: GM_webRequest"]);
  assert.equal(m.world, "isolated");
});

test("page-world scripts can't use extension GM functions", () => {
  const m = parseUserScript("a.user.js", userscript(`@match https://x.com/*\n@grant GM_setValue\n@grant GM_addStyle\n@inject-into page`));
  assert.match(m.warnings?.join() ?? "", /GM_setValue can't work/);
});

test("any grant but none means the isolated world, even an unsupported one", () => {
  assert.equal(parseUserScript("a.user.js", userscript(`@match https://x.com/*\n@grant GM_download`)).world, "isolated");
  assert.equal(parseUserScript("a.user.js", userscript(`@match https://x.com/*\n@grant none`)).world, "main");
});

test("@run-at", () => {
  const at = (v: string) => parseUserScript("a.user.js", userscript(`@match https://x.com/*\n@run-at ${v}`)).runAt;
  assert.equal(at("document-start"), "document_start");
  assert.equal(at("document-end"), "document_end");
  assert.equal(at("document-body"), "document_end");
  assert.equal(at("document-idle"), "document_idle");
});

test("@include globs and regexes become a filter", () => {
  const m = parseUserScript("a.user.js", userscript(`
    @include https://*.google.tld/search*
    @include /^https?://example\\.org/\\d+$/
    @exclude *://*/*?nope*
  `));
  assert.equal(m.error, undefined);
  assert.deepEqual(m.matches, ["*://*/*"]);
  assert.ok(m.filter);
  const ok = (u: string) => modApplies(m, u);
  assert.ok(ok("https://www.google.com/search?q=1"));
  assert.ok(ok("https://www.google.co.uk/search?q=1"));
  assert.ok(!ok("https://www.google.com/maps"));
  assert.ok(ok("http://example.org/42"));
  assert.ok(!ok("http://example.org/42x"));
  assert.ok(!ok("https://www.google.com/search?nope=1"));
});

test("@include * is every site", () => {
  const m = parseUserScript("a.user.js", userscript(`@include *`));
  assert.ok(modApplies(m, "https://anything.example/"));
  assert.deepEqual(m.sites, []);
});

test("Tampermonkey-only patterns are fixed or filtered", () => {
  const m = parseUserScript("a.user.js", userscript(`@match http*://example.com/*`));
  assert.deepEqual(m.matches, ["*://example.com/*"]);
  const noPath = parseUserScript("a.user.js", userscript(`@match https://example.com`));
  assert.deepEqual(noPath.matches, ["https://example.com/*"]);
  const tld = parseUserScript("a.user.js", userscript(`@match https://www.amazon.tld/*`));
  assert.ok(tld.filter);
  assert.ok(modApplies(tld, "https://www.amazon.de/dp/1"));
  assert.ok(!modApplies(tld, "https://www.amazon.evil.com/"));
});

test("errors: no header, nowhere to run", () => {
  assert.match(parseUserScript("a.user.js", "console.log(1)").error ?? "", /header/);
  assert.match(parseUserScript("a.user.js", userscript(`@name x`)).error ?? "", /@match/);
});

test("@require, @resource, @connect and GM_info", () => {
  const m = parseUserScript("a.user.js", userscript(`
    @name X
    @namespace me
    @match https://x.com/*
    @require https://cdn.example/jquery.js#sha256=abc
    @resource logo https://cdn.example/logo.png
    @connect api.example.com
    @grant GM_xmlhttpRequest
  `));
  assert.deepEqual(m.requireUrls, ["https://cdn.example/jquery.js#sha256=abc"]);
  assert.deepEqual(m.resourceUrls, { logo: "https://cdn.example/logo.png" });
  assert.deepEqual(m.connects, ["api.example.com"]);
  const script = (m.info as { script: Record<string, unknown> }).script;
  assert.equal(script.namespace, "me");
  assert.equal(script.noframes, false);
  assert.match((m.info as { scriptMetaStr: string }).scriptMetaStr, /==UserScript==/);
});

test("a mod on several sites lists each once", () => {
  const m = parseUserScript("a.user.js", userscript(`@match https://www.google.com/search*\n@match https://bing.com/*\n@match https://*.google.com/maps/*\n@include https://duckduckgo.com/*`));
  assert.deepEqual(m.sites, ["google.com", "bing.com", "duckduckgo.com"]);
});

test("site names from regexes", () => {
  const site = (inc: string) => parseUserScript("a.user.js", userscript(`@include ${inc}`)).sites.join();
  assert.equal(site("/^https?://www\\.example\\.org/\\d+$/"), "example.org");
  assert.equal(site("/127\\.0\\.0\\.1:8123\\/page/"), "127.0.0.1");
  const css = parseUserCss("x.user.css", `/* ==UserStyle==\n@name X\n==/UserStyle== */\n@-moz-document regexp("http://127\\\\.0\\\\.0\\\\.1(:\\\\d+)?/.*") { a {} }`);
  assert.deepEqual(css.sites, ["127.0.0.1"]);
});

// ---------- UserCSS ----------

const usercss = (body: string, header = "@name Dark\n@version 1.0") =>
  `/* ==UserStyle==\n${header}\n==/UserStyle== */\n${body}`;

test("@-moz-document sections", () => {
  const m = parseUserCss("d.user.css", usercss(`
@namespace url(http://www.w3.org/1999/xhtml);
/* a comment */
@-moz-document domain("github.com"), url-prefix("https://gist.github.com/") {
  body { color: red; }
  @media (min-width: 1px) { a { color: blue; } }
}
@-moz-document regexp("https?://example\\\\.com/\\\\d+") {
  p { margin: 0 }
}
`));
  assert.equal(m.error, undefined);
  assert.equal(m.name, "Dark");
  assert.equal(m.sections?.length, 2);
  assert.match(m.sections![0].css, /@media/);
  assert.deepEqual(m.sections![0].rules, [{ type: "domain", value: "github.com" }, { type: "prefix", value: "https://gist.github.com/" }]);
  assert.deepEqual(m.sections![1].rules, [{ type: "regex", source: "^(?:https?://example\\.com/\\d+)$" }]);
  assert.deepEqual(m.matches.sort(), ["*://*/*"]);
  assert.ok(modApplies(m, "https://api.github.com/x"));
  assert.ok(modApplies(m, "https://example.com/12"));
  assert.ok(!modApplies(m, "https://example.com/12/x"));
  assert.ok(!modApplies(m, "https://gitlab.com/"));
  assert.deepEqual(m.sites, ["github.com", "example.com"]);
  assert.equal(m.runAt, "document_start");
});

test("narrow registration when every rule has a host", () => {
  const m = parseUserCss("d.user.css", usercss(`@-moz-document domain("github.com"), url("https://example.com/a?b=1") { a{} }`));
  assert.deepEqual(m.matches.sort(), ["*://*.github.com/*", "https://example.com/a*"]);
});

test("code outside sections applies everywhere; comments and @namespace don't count", () => {
  const onlyGlobal = parseUserCss("d.user.css", usercss(`body { color: red }`));
  assert.equal(onlyGlobal.sections?.length, 1);
  assert.ok(modApplies(onlyGlobal, "https://anything.example/"));
  const sectionsOnly = parseUserCss("d.user.css", usercss(`/* hi */ @namespace x; @-moz-document domain("a.com") { a{} }`));
  assert.equal(sectionsOnly.sections?.length, 1);
  assert.ok(!modApplies(sectionsOnly, "https://b.com/"));
});

test("strings and comments don't confuse the section scanner", () => {
  const s = splitSections(`@-moz-document domain("a.com") { a::before { content: "}"; } /* } */ b { c: d } }`);
  assert.equal(s.length, 1);
  assert.match(s[0].css, /b \{ c: d \}$/);
});

test("@var defaults become custom properties", () => {
  const m = parseUserCss("d.user.css", usercss(`@-moz-document domain("a.com") { a { color: var(--accent) } }`, `@name V
@var color accent "Accent color" #ff0000
@var checkbox compact "Compact" 1
@var number size "Size" [12, 8, 20, 1, "px"]
@var select theme "Theme" {
  "Light": "#fff",
  "Dark*": "#000"
}`));
  assert.equal(m.error, undefined);
  assert.equal(m.warnings, undefined);
  const css = m.sections![0].css;
  assert.match(css, /--accent: #ff0000;/);
  assert.match(css, /--compact: 1;/);
  assert.match(css, /--size: 12px;/);
  assert.match(css, /--theme: #000;/);
});

test("@var values the user set replace the defaults, if valid", () => {
  const src = usercss(`a { color: var(--accent) }`, `@name V
@var color accent "Accent color" #ff0000
@var range size "Size" [12, 8, 20, 1, "px"]
@var select theme "Theme" ["light:Light|#fff", "dark:Dark*|#000"]
@var text font "Font" "serif"`);
  const m = parseUserCss("d.user.css", src, { accent: "#00ff00", size: "14", theme: "#fff", font: "x; } body { display: none" });
  const css = m.sections![0].css;
  assert.match(css, /--accent: #00ff00;/);
  assert.match(css, /--size: 14px;/);
  assert.match(css, /--theme: #fff;/);
  assert.match(css, /--font: serif;/); // can't break out of the declaration
  const vars = m.vars!;
  assert.deepEqual(vars.map((v) => [v.name, v.type, v.label, v.default, v.value]), [
    ["accent", "color", "Accent color", "#ff0000", "#00ff00"],
    ["size", "range", "Size", "12", "14"],
    ["theme", "select", "Theme", "#000", "#fff"],
    ["font", "text", "Font", "serif", "x; } body { display: none"],
  ]);
  assert.deepEqual(vars[1], { ...vars[1], min: 8, max: 20, step: 1, unit: "px" });
  assert.deepEqual(vars[2].options, [{ label: "Light", value: "#fff" }, { label: "Dark", value: "#000" }]);
  assert.equal(parseUserCss("d.user.css", src, { theme: "#123" }).sections![0].css.match(/--theme: [^;]*/)![0], "--theme: #000");
});

test("preprocessors aren't supported", () => {
  assert.match(parseUserCss("d.user.css", usercss(`a{}`, "@name P\n@preprocessor stylus")).error ?? "", /stylus/);
  assert.match(parseUserCss("d.user.css", `a{}`).error ?? "", /header/);
});

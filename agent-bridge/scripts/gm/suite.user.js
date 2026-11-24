// ==UserScript==
// @name         GM API suite
// @namespace    eyepatch-tests
// @version      1.0
// @description  Exercises the GM API; test-gm.mjs runs it in Eyepatch and in Violentmonkey and compares.
// @match        http://127.0.0.1:8124/suite.html*
// @connect      other.test
// @resource     note http://127.0.0.1:8124/note.txt
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_getValues
// @grant        GM_setValues
// @grant        GM_deleteValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_openInTab
// @grant        GM_addStyle
// @grant        GM_addElement
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @grant        GM.getResourceUrl
// @grant        GM_info
// @noframes
// ==/UserScript==

// Each test returns a JSON value; test-gm.mjs compares them with
// reference.json (recorded from Violentmonkey). Results go in the DOM, which
// every world shares.

(async () => {
  const root = document.documentElement.dataset;
  const ORIGIN = "http://127.0.0.1:8124";
  // Other hosts (test-gm.mjs maps them to 127.0.0.1).
  const OTHER = "http://other.test:8124"; // allowed by @connect
  const BLOCKED = "http://blocked.test:8124"; // not in @connect

  // Another tab sets a value; the main tab's listener should hear it.
  if (location.search.includes("peer")) {
    GM_setValue("cross", "from-peer");
    root.peerDone = "1";
    return;
  }

  const results = {};
  const timeout = (ms) => new Promise((_, no) => setTimeout(() => no(new Error("timed out")), ms));
  const test = async (name, fn) => {
    try {
      results[name] = await Promise.race([fn(), timeout(8000)]);
    } catch (e) {
      results[name] = { threw: String(e?.message ?? e) };
    }
  };
  /** GM_xmlhttpRequest as a promise of the callback that fired and its response. */
  const xhr = (details) =>
    new Promise((resolve) => {
      const seen = [];
      const done = (kind) => (r) => resolve({ kind, r, seen });
      GM_xmlhttpRequest({
        ...details,
        onloadstart: () => seen.push("loadstart"),
        onreadystatechange: (r) => seen.push(`rs${r.readyState}`),
        onload: done("load"),
        onerror: done("error"),
        ontimeout: done("timeout"),
        onabort: done("abort"),
      });
    });
  const echo = (r) => JSON.parse(r.responseText);

  for (const k of GM_listValues()) if (k !== "startCount") GM_deleteValue(k);

  // ---------- storage ----------
  await test("getValue: missing key gives the default", () => GM_getValue("nope", "dflt"));
  await test("getValue: missing key without a default", () => String(GM_getValue("nope")));
  await test("set/get round-trips types", () => {
    const vals = { s: "str", n: 42, z: 0, f: false, t: true, nul: null, o: { a: [1, { b: "c" }] }, arr: [1, "2"], u: "ünï €" };
    for (const [k, v] of Object.entries(vals)) GM_setValue(`type_${k}`, v);
    return Object.fromEntries(Object.keys(vals).map((k) => [k, GM_getValue(`type_${k}`)]));
  });
  await test("getValue returns a copy", () => {
    GM_setValue("obj", { x: 1 });
    GM_getValue("obj").x = 2;
    return GM_getValue("obj");
  });
  await test("setValue keeps a copy", () => {
    const o = { x: 1 };
    GM_setValue("obj2", o);
    o.x = 2;
    return GM_getValue("obj2");
  });
  await test("deleteValue", () => {
    GM_setValue("del", 1);
    GM_deleteValue("del");
    return [GM_getValue("del", "gone"), GM_listValues().includes("del")];
  });
  await test("listValues", () => GM_listValues().filter((k) => !k.startsWith("type_") && k !== "startCount").sort());
  await test("getValues with keys", () => GM_getValues(["obj", "missing"]));
  await test("getValues with defaults", () => GM_getValues({ obj: 0, missing: "d" }));
  await test("setValues and deleteValues", () => {
    GM_setValues({ m1: 1, m2: [2] });
    const set = GM_getValues(["m1", "m2"]);
    GM_deleteValues(["m1", "m2"]);
    return [set, GM_getValues(["m1", "m2"])];
  });
  await test("GM.* storage promises", async () => {
    await GM.setValue("p", { q: 1 });
    const got = await GM.getValue("p");
    const def = await GM.getValue("nope", 5);
    const listed = (await GM.listValues()).includes("p");
    await GM.deleteValue("p");
    return [got, def, listed, await GM.getValue("p", "gone")];
  });
  await test("GM.* and GM_* share storage", async () => {
    GM_setValue("shared", 1);
    return GM.getValue("shared");
  });
  await test("value change listener (same tab)", async () => {
    const calls = [];
    const id = GM_addValueChangeListener("watched", (...a) => calls.push(a));
    GM_setValue("watched", 1);
    GM_setValue("watched", 1); // unchanged
    GM_setValue("watched", { v: 2 });
    GM_deleteValue("watched");
    await new Promise((r) => setTimeout(r, 300));
    GM_removeValueChangeListener(id);
    GM_setValue("watched", 3);
    await new Promise((r) => setTimeout(r, 300));
    return { idType: typeof id, calls };
  });
  // The harness opens ?peer in another tab after this result appears.
  const cross = new Promise((resolve) => GM_addValueChangeListener("cross", (key, oldValue, newValue, remote) => resolve({ key, oldValue, newValue, remote })));
  root.waitingForPeer = "1";
  await test("value change listener (another tab)", () => cross);

  // ---------- GM_xmlhttpRequest ----------
  await test("xhr: GET same origin", async () => {
    const { kind, r, seen } = await xhr({ url: `${ORIGIN}/echo?a=1` });
    return { kind, status: r.status, statusText: r.statusText, readyState: r.readyState, finalUrl: r.finalUrl, method: echo(r).method, ctype: /content-type: application\/json/i.test(r.responseHeaders), seen: [...new Set(seen)].sort() };
  });
  await test("xhr: relative URL", async () => {
    const { r } = await xhr({ url: "/echo?rel=1" });
    return echo(r).url;
  });
  await test("xhr: cross-origin @connect host", async () => {
    const { kind, r } = await xhr({ url: `${OTHER}/echo` });
    return { kind, status: r.status, host: echo(r).host };
  });
  await test("xhr: host not in @connect", async () => {
    const { kind, r } = await xhr({ url: `${BLOCKED}/echo` });
    return { kind, status: r.status };
  });
  await test("xhr: redirect to a host not in @connect", async () => {
    const { kind, r } = await xhr({ url: `${OTHER}/redirect?to=${encodeURIComponent(`${BLOCKED}/echo`)}` });
    return { kind, status: r.status };
  });
  await test("xhr: POST string body and headers", async () => {
    const { r } = await xhr({ method: "POST", url: `${OTHER}/echo`, data: "hello", headers: { "X-Test": "yes", "Content-Type": "text/plain" } });
    const e = echo(r);
    return { method: e.method, body: e.body, xtest: e.headers["x-test"], ctype: e.headers["content-type"] };
  });
  await test("xhr: URLSearchParams body", async () => {
    const { r } = await xhr({ method: "POST", url: `${OTHER}/echo`, data: new URLSearchParams({ a: "1", b: "x y" }) });
    const e = echo(r);
    return { body: e.body, ctype: e.headers["content-type"]?.split(";")[0] };
  });
  await test("xhr: FormData body", async () => {
    const fd = new FormData();
    fd.append("a", "1");
    fd.append("f", new Blob(["file!"], { type: "text/plain" }), "f.txt");
    const { r } = await xhr({ method: "POST", url: `${OTHER}/echo`, data: fd });
    const e = echo(r);
    return { multipart: /^multipart\/form-data; boundary=/.test(e.headers["content-type"]), hasField: e.body.includes('name="a"'), hasFile: e.body.includes("file!") };
  });
  await test("xhr: binary body", async () => {
    const { r } = await xhr({ method: "POST", url: `${OTHER}/echo`, data: new Uint8Array([104, 105]) });
    return echo(r).body;
  });
  await test("xhr: responseType json", async () => {
    const { r } = await xhr({ url: `${OTHER}/echo`, responseType: "json" });
    return typeof r.response === "object" && r.response.method;
  });
  await test("xhr: responseType arraybuffer", async () => {
    const { r } = await xhr({ url: `${OTHER}/bytes`, responseType: "arraybuffer" });
    return [r.response instanceof ArrayBuffer, [...new Uint8Array(r.response)]];
  });
  await test("xhr: responseType blob", async () => {
    const { r } = await xhr({ url: `${OTHER}/bytes`, responseType: "blob" });
    return [r.response instanceof Blob, r.response.size, r.response.type, [...new Uint8Array(await r.response.arrayBuffer())]];
  });
  await test("xhr: responseType document", async () => {
    const { r } = await xhr({ url: `${OTHER}/doc.html`, responseType: "document" });
    return r.response?.querySelector?.("h1")?.textContent ?? null;
  });
  await test("xhr: responseXML", async () => {
    const { r } = await xhr({ url: `${OTHER}/doc.xml` });
    return r.responseXML?.querySelector?.("item")?.textContent ?? null;
  });
  await test("xhr: 404 still loads", async () => {
    const { kind, r } = await xhr({ url: `${OTHER}/missing` });
    return { kind, status: r.status };
  });
  await test("xhr: follows redirects, finalUrl", async () => {
    const { kind, r } = await xhr({ url: `${OTHER}/redirect?to=${encodeURIComponent(`${OTHER}/echo?after=1`)}` });
    return { kind, status: r.status, finalUrl: r.finalUrl };
  });
  await test("xhr: timeout", async () => {
    const { kind } = await xhr({ url: `${OTHER}/slow`, timeout: 300 });
    return kind;
  });
  await test("xhr: abort", async () => {
    let handle;
    const p = new Promise((resolve) => {
      handle = GM_xmlhttpRequest({ url: `${OTHER}/slow`, onabort: () => resolve("abort"), onload: () => resolve("load"), onerror: () => resolve("error") });
    });
    setTimeout(() => handle.abort(), 100);
    return [typeof handle.abort, await p];
  });
  await test("xhr: context is passed back", async () => {
    const { r } = await xhr({ url: `${OTHER}/echo`, context: { c: 1 } });
    return r.context;
  });
  await test("xhr: network error", async () => {
    const { kind, r } = await xhr({ url: "http://other.test:1/" });
    return { kind, status: r.status };
  });
  await test("xhr: sends the target's cookies", async () => {
    await xhr({ url: `${OTHER}/set-cookie` });
    const { r } = await xhr({ url: `${OTHER}/echo` });
    return /sid=abc/.test(echo(r).headers.cookie ?? "");
  });
  await test("xhr: anonymous sends no cookies", async () => {
    const { r } = await xhr({ url: `${OTHER}/echo`, anonymous: true });
    return /sid=abc/.test(echo(r).headers.cookie ?? "");
  });
  await test("GM.xmlHttpRequest resolves", async () => {
    const r = await GM.xmlHttpRequest({ url: `${OTHER}/echo` });
    return [r.status, echo(r).method];
  });
  await test("GM.xmlHttpRequest rejects on network error", async () => {
    try {
      await GM.xmlHttpRequest({ url: "http://other.test:1/" });
      return "resolved";
    } catch (e) {
      return "rejected";
    }
  });

  // ---------- the rest ----------
  await test("GM_info", () => ({
    name: GM_info.script.name,
    version: GM_info.script.version,
    namespace: GM_info.script.namespace,
    grantsGetValue: GM_info.script.grant.includes("GM_getValue"),
    matches: GM_info.script.matches,
    metaStr: /@name\s+GM API suite/.test(GM_info.scriptMetaStr),
    handler: typeof GM_info.scriptHandler,
    resources: GM_info.script.resources.map((r) => r.name),
  }));
  await test("GM.info is GM_info's data", () => GM.info.script.name);
  await test("addStyle", () => {
    const s = GM_addStyle("#suite-out { color: rgb(1, 2, 3); }");
    return [s instanceof HTMLStyleElement, s.isConnected, getComputedStyle(document.getElementById("suite-out")).color];
  });
  await test("addElement with a parent", () => {
    const el = GM_addElement(document.body, "span", { id: "added", textContent: "hi", "data-x": "1" });
    return [el.tagName, el.parentNode === document.body, el.textContent, el.dataset.x];
  });
  await test("addElement without a parent", () => {
    const el = GM_addElement("meta", { name: "suite" });
    return [el.tagName, el.isConnected];
  });
  await test("getResourceText", () => GM_getResourceText("note"));
  await test("getResourceURL", () => {
    const u = GM_getResourceURL("note");
    return /^(data|blob):/.test(u);
  });
  await test("GM.getResourceUrl", async () => /^(data|blob):/.test(await GM.getResourceUrl("note")));
  await test("registerMenuCommand", () => {
    const id = GM_registerMenuCommand("Suite command", () => (root.menu = "ran"));
    const id2 = GM_registerMenuCommand("Gone", () => {});
    GM_unregisterMenuCommand(id2);
    return [typeof id, id !== id2];
  });
  await test("openInTab handle", () => {
    const t = GM_openInTab(`${ORIGIN}/opened.html`, true);
    return [typeof t, typeof t.close, t.closed];
  });

  // suite.html sets window.appState = 7 in the page.
  await test("unsafeWindow reads page globals", () => unsafeWindow.appState);
  await test("unsafeWindow sets page globals", () => {
    unsafeWindow.fromScript = { n: 5 };
    return unsafeWindow.fromScript.n;
  });
  await test("unsafeWindow calls page functions, with callbacks", () => unsafeWindow.Array.from([1, 2, 3], (x) => x * 2).join(","));
  await test("unsafeWindow.document is the page's", () => unsafeWindow.document.getElementById("suite-out").id);

  root.gmSuite = JSON.stringify(results);
})();

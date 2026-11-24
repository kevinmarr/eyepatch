// unsafeWindow for userscripts in an isolated world: the page's own window,
// reached through a bridge. Chrome gives an isolated world no handle on the
// page's JS objects, but events dispatched on the shared DOM run listeners in
// every world synchronously. So a small script in the page's world
// (pageBridge) answers requests from the userscript's world (windowProxy):
// get, set, call, construct, has, delete and keys, on page objects named by
// handle. Values cross as JSON; DOM nodes cross as the `relatedTarget` of a
// MouseEvent (each world gets its own wrapper of the same node); functions
// the userscript passes to the page are called back the same way.
//
// Both functions are injected into pages by source, so they must not
// reference anything outside themselves. Like unsafeWindow in any userscript
// manager, the page can see and tamper with this channel: treat what comes
// back as untrusted.

/** Runs in the page's world, before the userscript. */
export function pageBridge(channel) {
  if (window[Symbol.for(channel)]) return;
  Object.defineProperty(window, Symbol.for(channel), { value: true });
  const objs = new Map([[0, window]]);
  const ids = new WeakMap([[window, 0]]);
  let seq = 0;
  let nodes = []; // nodes sent along with the next request
  let reply = null; // the userscript's answer to a callback

  /** With a node, its JSON goes first as `<type>-detail`, then the node as a MouseEvent's relatedTarget. */
  const send = (type, detail, node) => {
    const name = `${channel}:${type}`;
    if (!node) return window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));
    if (detail != null) window.dispatchEvent(new CustomEvent(`${name}-detail`, { detail: JSON.stringify(detail) }));
    window.dispatchEvent(new MouseEvent(name, { relatedTarget: node }));
  };
  /** A page value as it crosses: a primitive, a node, or a handle. */
  const out = (v) => {
    if (v === undefined) return { u: 1 };
    if (v === null || (typeof v !== "object" && typeof v !== "function")) {
      return typeof v === "number" && !Number.isFinite(v) ? { num: String(v) } : typeof v === "bigint" ? { big: String(v) } : typeof v === "symbol" ? { u: 1 } : { v };
    }
    if (v instanceof Node) return { node: 1, keep: v };
    let id = ids.get(v);
    if (id === undefined) {
      id = ++seq;
      ids.set(v, id);
      objs.set(id, v);
    }
    return { o: id, f: typeof v === "function" };
  };
  /** A value from the userscript: a primitive, JSON, a node, a page handle, or one of its functions. */
  const into = (r) => {
    if (r.u) return undefined;
    if ("o" in r) return objs.get(r.o);
    if ("n" in r) return nodes[r.n];
    if ("cb" in r) {
      const id = r.cb;
      return function (...args) {
        reply = null;
        const sent = [];
        const enc = (v) => {
          const x = out(v);
          if (x.node) {
            sent.push(x.keep);
            return { n: sent.length - 1 };
          }
          return x;
        };
        const msg = { cb: id, t: enc(this), a: args.map(enc) };
        for (const n of sent) send("cbnode", null, n);
        send("cb", msg);
        const r = reply;
        reply = null;
        if (!r) return undefined;
        if (r.e) throw new Error(r.e);
        return into(r.r);
      };
    }
    if ("num" in r) return Number(r.num);
    if ("big" in r) return BigInt(r.big);
    return r.v;
  };

  window.addEventListener(`${channel}:node`, (e) => nodes.push(e.relatedTarget), true);
  window.addEventListener(`${channel}:cbres`, (e) => (reply = JSON.parse(e.detail)), true);
  window.addEventListener(`${channel}:req`, (e) => {
    const req = JSON.parse(e.detail);
    let res;
    try {
      const target = objs.get(req.o);
      if (target === undefined) throw new Error("that page object is gone");
      let v;
      switch (req.op) {
        case "get":
          v = target[req.k];
          break;
        case "set":
          target[req.k] = into(req.v);
          v = true;
          break;
        case "delete":
          v = delete target[req.k];
          break;
        case "has":
          v = req.k in target;
          break;
        case "keys":
          v = JSON.stringify(Reflect.ownKeys(target).filter((k) => typeof k === "string"));
          break;
        case "call":
          v = Reflect.apply(target, into(req.t), req.a.map(into));
          break;
        case "construct":
          v = Reflect.construct(target, req.a.map(into));
          break;
        case "release":
          for (const id of req.ids) {
            if (id === 0) continue;
            ids.delete(objs.get(id));
            objs.delete(id);
          }
          break;
      }
      res = { r: out(v) };
    } catch (err) {
      res = { e: String(err?.message ?? err) };
    }
    nodes = [];
    const node = res.r?.keep;
    if (res.r) delete res.r.keep;
    send("res", res, node);
  }, true);
}

/** Runs in the userscript's world: a proxy of the page's window. */
export function windowProxy(channel) {
  const HANDLE = Symbol("handle");
  let answer = null;
  let answerNode = null;
  const callbacks = new Map();
  let cbSeq = 0;
  let cbNodes = [];
  const fns = new WeakMap(); // the userscript's functions -> callback id

  const send = (type, detail) => window.dispatchEvent(new CustomEvent(`${channel}:${type}`, { detail: JSON.stringify(detail) }));
  window.addEventListener(`${channel}:res-detail`, (e) => (answer = JSON.parse(e.detail)), true);
  window.addEventListener(`${channel}:res`, (e) => {
    if (e instanceof MouseEvent) answerNode = e.relatedTarget;
    else answer = JSON.parse(e.detail);
  }, true);
  window.addEventListener(`${channel}:cbnode`, (e) => cbNodes.push(e.relatedTarget), true);

  /** A value going to the page. */
  const out = (v, nodes) => {
    if (v === undefined) return { u: 1 };
    if (v && (typeof v === "object" || typeof v === "function") && v[HANDLE] !== undefined) return { o: v[HANDLE] };
    if (v instanceof Node) {
      nodes.push(v);
      return { n: nodes.length - 1 };
    }
    if (typeof v === "function") {
      let id = fns.get(v);
      if (id === undefined) {
        id = ++cbSeq;
        fns.set(v, id);
        callbacks.set(id, v);
      }
      return { cb: id };
    }
    if (typeof v === "number" && !Number.isFinite(v)) return { num: String(v) };
    if (typeof v === "bigint") return { big: String(v) };
    if (v && typeof v === "object") return { v: JSON.parse(JSON.stringify(v)) };
    return { v };
  };
  /** A value from the page. */
  const into = (r, node) => {
    if (r.u) return undefined;
    if (r.node) return node;
    if ("o" in r) return handle(r.o, r.f);
    if ("n" in r) return cbNodes[r.n];
    if ("num" in r) return Number(r.num);
    if ("big" in r) return BigInt(r.big);
    return r.v;
  };
  const request = (req) => {
    const nodes = [];
    const enc = (v) => out(v, nodes);
    if ("v" in req) req.v = enc(req.v);
    if (req.t !== undefined || req.op === "call") req.t = enc(req.t);
    if (req.a) req.a = req.a.map(enc);
    for (const n of nodes) window.dispatchEvent(new MouseEvent(`${channel}:node`, { relatedTarget: n }));
    answer = answerNode = null;
    send("req", req);
    const a = answer;
    const node = answerNode;
    answer = answerNode = null;
    if (!a) throw new Error("unsafeWindow: the page didn't answer");
    if (a.e) throw new Error(a.e);
    return into(a.r, node);
  };

  // The page calls one of the userscript's functions.
  window.addEventListener(`${channel}:cb`, (e) => {
    const msg = JSON.parse(e.detail);
    const nodes = cbNodes;
    let res;
    try {
      const fn = callbacks.get(msg.cb);
      const conv = (r) => (r && "n" in r ? nodes[r.n] : into(r, null));
      const v = fn.apply(conv(msg.t), msg.a.map(conv));
      res = { r: out(v, []) };
    } catch (err) {
      res = { e: String(err?.message ?? err) };
    }
    cbNodes = [];
    send("cbres", res);
  }, true);

  const handles = new Map(); // id -> WeakRef(proxy)
  const released = new FinalizationRegistry((id) => {
    handles.delete(id);
    try {
      send("req", { op: "release", o: 0, ids: [id] });
    } catch {}
  });
  function handle(id, isFn) {
    const known = handles.get(id)?.deref();
    if (known) return known;
    // A function target so the proxy can be called; keys are the page object's.
    const target = isFn ? function () {} : {};
    const p = new Proxy(target, {
      get(_, k) {
        if (k === HANDLE) return id;
        if (typeof k === "symbol") return k === Symbol.toPrimitive ? () => `[unsafeWindow object]` : undefined;
        if (k === "then" && !isFn) return undefined; // not a promise, so `await` doesn't call into the page
        return request({ op: "get", o: id, k });
      },
      set(_, k, v) {
        if (typeof k === "symbol") return false;
        return request({ op: "set", o: id, k, v });
      },
      has(_, k) {
        return typeof k === "symbol" ? false : request({ op: "has", o: id, k });
      },
      deleteProperty(_, k) {
        return typeof k === "symbol" ? false : request({ op: "delete", o: id, k });
      },
      ownKeys(t) {
        const keys = JSON.parse(request({ op: "keys", o: id }));
        // A function target's own non-configurable keys must be listed.
        return [...new Set([...keys, ...Reflect.ownKeys(t).filter((k) => !Object.getOwnPropertyDescriptor(t, k).configurable)])];
      },
      getOwnPropertyDescriptor(t, k) {
        const own = Object.getOwnPropertyDescriptor(t, k);
        if (own && !own.configurable) return own;
        if (typeof k === "symbol" || !request({ op: "has", o: id, k })) return undefined;
        return { value: request({ op: "get", o: id, k }), writable: true, enumerable: true, configurable: true };
      },
      apply(_, thisArg, args) {
        return request({ op: "call", o: id, t: thisArg, a: args });
      },
      construct(_, args) {
        return request({ op: "construct", o: id, a: args });
      },
    });
    handles.set(id, new WeakRef(p));
    if (id !== 0) released.register(p, id);
    return p;
  }
  return handle(0, false);
}

// Chrome match patterns, so the extension can tell which mods apply to a URL.
// Same logic as agent-bridge/src/match.ts.

const SCHEMES = new Set(["http", "https", "file", "ftp", "ws", "wss"]);

function globToRegExp(glob) {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

export function matchesPattern(pattern, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1);
  if (pattern === "<all_urls>") return SCHEMES.has(scheme);

  const m = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, pScheme, pHost, pPath] = m;

  // `*` scheme means http or https only.
  if (pScheme === "*" ? scheme !== "http" && scheme !== "https" : pScheme !== scheme) return false;

  // Ports aren't part of the host match.
  const host = url.hostname.toLowerCase();
  const wantHost = pHost.toLowerCase().replace(/:\d+$/, "");
  if (scheme !== "file" && wantHost !== "*") {
    if (wantHost.startsWith("*.")) {
      const base = wantHost.slice(2);
      if (host !== base && !host.endsWith("." + base)) return false;
    } else if (host !== wantHost) {
      return false;
    }
  }

  return globToRegExp(pPath).test(url.pathname + url.search);
}

export function modApplies(mod, url) {
  return (
    mod.matches.some((p) => matchesPattern(p, url)) &&
    !(mod.excludeMatches ?? []).some((p) => matchesPattern(p, url))
  );
}

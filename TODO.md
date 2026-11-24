# TODO

Work left before Eyepatch is a product other people can install. Roughly
in order.

## 1. Setup flow

The Options page is the setup page: Chrome opens it on install, and it has a
checklist (Agent Bridge running, Allow User Scripts, an agent installed), the
installed agents with sign-in, and the agent catalog. Still needed:

- **Signing secrets:** the release workflow signs and notarizes the macOS
  builds once the Apple secrets it lists are set; until then they're ad-hoc
  signed (fine with the `curl | sh` installer, which doesn't quarantine).
  Windows builds are unsigned (SmartScreen); `irm | iex` doesn't mark them
  either.
- **First release:** push `v0.1.0` and run the install command on a Mac and
  a Linux machine that never had the dev setup. Then the first real update:
  release `v0.1.1`, point `BRIDGE_VERSION` at it in an unpacked copy, and
  watch Eyepatch update Agent Bridge (`bun run test:update` does this with a
  fake release, on Linux only so far).
- **Shorter install URL** (a domain): the raw.githubusercontent.com command
  doesn't fit in the Setup step's box.

## 2. Test in real Chrome

Only tested with the fake extension (`npm run fake-extension`), a mock-up of
the side panel, or not at all:

- Agent Bridge on Windows: registry keys, zip handling, musl, the browser 
  tools' socket and the dev socket (named pipes on Windows), and the dev 
  shim's `.cmd` launcher.
- npm agents on Bun beyond starting a chat: the npm agents we offer were
  checked up to `session/new` (most stop at "authenticate first"), not
  through a real conversation. Claude Agent on Windows comes from npm too.
- Browser tools with agents other than Claude Agent, Cursor, and Codex (only 
  those three were tried), including whether screenshots reach the model.

## 3. Agents

- **Agents you installed yourself** (Settings → Add an agent: "On this
  computer", or "Use a command"): untested with real agents. Check that the
  login-shell PATH lookup finds Homebrew/npm installs when Chrome starts Agent
  Bridge on macOS, that the hidden registry agents (pi ACP, Nova, Qoder,
  MiniMax Code) work this way on your own Node, and Windows (`.cmd` shims).

## 4. Mods

- **Updates for imported mods:** scripts from Greasy Fork and similar have
  `@updateURL`/`@downloadURL`. Check them, offer the update in Settings, and
  stop once the agent or the user has edited the file.
- **`unsafeWindow`** in isolated scripts is a bridge to the page's `window`
  (`extension/unsafe-window.js`). Untested with real-world scripts (e.g. ones
  that hook page functions heavily); each access is a synchronous round trip.
- **More of the GM API:** `GM_webRequest`. Forbidden headers in
  `GM_xmlhttpRequest` (Cookie, Referer, User-Agent...) are set with a
  declarativeNetRequest session rule; they aren't reapplied after a redirect.
  `GM_notification`'s `onclick` is untested (the GM
  suite can't click a notification); `ondone` is covered. `GM_download` and
  `GM_cookie` use optional permissions that Settings asks for on the mod's
  row; the GM suite runs with them pre-granted, so check the "Allow
  downloads" button and the not-yet-allowed error by hand.
- **UserCSS:** `@var` values are fixed at their defaults. Settings could let
  you change them. Preprocessors (Stylus, Less) aren't supported.

## 5. Chrome Web Store

The privacy policy is `PRIVACY.md` and `bun run package:extension` makes the
zip. Still:

- **Store images:** icon, promo tile and screenshots (the side panel over a
  real site, mid change, and the site after).
- **First upload:** `bun run package:extension --key key.pem`, and check the
  ID the dashboard shows is `ilbbppjdddgjalodmdcmgdigaakgblpe` before
  submitting. (Unverified: that the store still takes `key.pem` in the zip to
  keep the ID.)

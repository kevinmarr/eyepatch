# TODO

Work left before Eyepatch is a product other people can install. Roughly
in order.

## 1. Setup flow

The Options page is the setup page: Chrome opens it on install, and it has a
checklist (Agent Bridge running, Allow User Scripts, an agent installed), the
installed agents with sign-in, and the agent catalog. Still missing:

- **Check again** for an agent that says it's signed out after you signed in
  elsewhere (e.g. in a terminal): today Agent Bridge only re-asks when the
  agent restarts.
- **Sign in again restarts the agent**, which interrupts replies in progress
  in tabs using it. Warn, or wait until they're done.

Also needed:

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
- **Release check:** the store zip script should refuse to package an
  extension whose `BRIDGE_VERSION` has no GitHub release yet.
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

- **Use an agent you already installed** instead of a managed copy: Settings
  could find ACP agents on your PATH (or take a command), for people who want
  to control the version or not spend the disk space. Today only the
  `EYEPATCH_AGENT` env var does this, for one agent and outside the UI. This
  would also unlock the registry agents we hide (`NOT_OFFERED` in
  `agent-bridge/src/agents.ts`): pi ACP, which expects `pi` on your PATH, and
  Nova, Qoder and MiniMax Code, which don't run on Bun but would run on your
  own Node.

## 4. Mods

- **Updates for imported mods:** scripts from Greasy Fork and similar have
  `@updateURL`/`@downloadURL`. Check them, offer the update in Settings, and
  stop once the agent or the user has edited the file.
- **`unsafeWindow`** in isolated scripts is the isolated `window`, not the
  page's. Scripts that grant GM functions and also read page globals need
  `@inject-into page`, where those GM functions don't work.
- **More of the GM API:** `GM_download`, `GM_cookie`, `GM_getTab`/`GM_saveTab`,
  `GM_webRequest`; forbidden request headers in `GM_xmlhttpRequest` (needs
  `declarativeNetRequest`); `GM_notification` click callbacks.
- **UserCSS:** `@var` values are fixed at their defaults. Settings could let
  you change them. Preprocessors (Stylus, Less) aren't supported.

## 5. Chrome Web Store

- Store icon and promo images from the Eyepatch mark.
- Store listing, screenshots, privacy disclosures, and justifications for the
  `userScripts`, `<all_urls>` and `nativeMessaging` permissions.
- First upload: include the extension's private key (`key.pem`, not in the
  repo) so the store keeps the ID in `manifest.json`'s `key`, which Agent
  Bridge's native messaging manifest allows.

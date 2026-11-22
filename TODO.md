# TODO

Work left before Eyepatch is a product other people can install. Roughly
in order.

## 1. Setup flow

The Options page is the setup page: Chrome opens it on install, and it has a
checklist (Agent Bridge running, Allow User Scripts, an agent installed), the
installed agents with sign-in, and the agent catalog. Still missing:

- **Install Agent Bridge** step: a "Download for macOS" button (detect the OS
  with `chrome.runtime.getPlatformInfo()`) instead of today's `bun run
  register:dev` command. The page already retries `connectNative` until it
  connects, and tells "not installed" from "dev server not running".
- **Check again** for an agent that says it's signed out after you signed in
  elsewhere (e.g. in a terminal): today Agent Bridge only re-asks when the
  agent restarts.
- **Sign in again restarts the agent**, which interrupts replies in progress
  in tabs using it. Warn, or wait until they're done.

Also needed:

- **Installer** per OS: copy the `bun run build` executable somewhere stable
  (e.g. `~/Library/Application Support/Eyepatch/`) and run its `install`
  command, which registers it with every Chromium-based browser found.
- **Builds in CI** for each platform (`bun run build --all` cross-compiles).
  The executable is about 110 MB (it includes Bun's runtime).
- **Code signing:** macOS blocks unsigned downloaded executables, so this needs
  an Apple Developer ID and notarization. Windows has the same issue
  (SmartScreen).
- **Version check:** Agent Bridge and the extension report their versions;
  show an update prompt when Agent Bridge is too old.
- **Uninstall:** removing the extension leaves Agent Bridge behind.
  `agent-bridge uninstall` removes the registrations; document deleting the
  executable and `~/.eyepatch` too.

## 2. Test in real Chrome

Only tested with the fake extension (`npm run fake-extension`), a mock-up of
the side panel, or not at all:

- The Options page in real Chrome (only previewed with made-up data): opening
  on install, installing and removing agents, a complete Sign in again with
  Claude Agent and Codex, and the side panel's Sign in button opening it at
  the right agent. Auto-update with Claude Agent (only tested with Codex).
- The banner hiding by itself after turning on Allow User Scripts.
- Agent Bridge on macOS and Windows (only run on Linux since moving to Bun
  and native messaging): registration (JSON files, registry keys on Windows),
  zip handling, musl, the browser tools' socket and the dev socket (named
  pipes on Windows), and the dev shim's `.cmd` launcher.
- npm agents on Bun beyond starting a chat: the npm agents we offer were
  checked up to `session/new` (most stop at "authenticate first"), not
  through a real conversation. Claude Agent on Windows comes from npm too.
- Browser tools with agents other than Claude Agent and Codex (only those two
  were tried), including whether screenshots reach the model.

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

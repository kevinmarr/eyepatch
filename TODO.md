# TODO

Work left before site-modder is a product other people can install. Roughly
in order: the first two sections change the architecture the most.

## 1. Replace the WebSocket with native messaging

Today the extension connects to Agent Bridge over `ws://127.0.0.1:7457`, and
you start Agent Bridge yourself in a terminal. Switch to Chrome native
messaging (`chrome.runtime.connectNative`):

- Chrome starts Agent Bridge on demand and talks to it over stdin/stdout.
  Nothing listens on a port.
- A small host manifest lists site-modder's extension ID as the only one
  allowed to start it. That replaces the Origin check and the hardcoded port.
- Agent Bridge needs to become a standalone executable (no Node install), e.g.
  Node's single-executable apps or `bun build --compile`. npm-based agents are
  currently installed with the npm next to Agent Bridge's Node, so this needs
  a plan too (bundle npm, or a Node runtime for agents, like Zed does).
- Check that the agent keeps working with the side panel closed: an open
  native messaging port should keep the service worker alive.
- Keep a dev mode: today Agent Bridge watches `extension/` and reloads the
  extension when files change. That should only happen in development.

## 2. Setup flow

The flow we agreed on:

1. Install the extension from the Chrome Web Store.
2. `chrome.runtime.onInstalled` opens a setup page in the extension.
3. **Install Agent Bridge:** a "Download for macOS" button (detect the OS with
   `chrome.runtime.getPlatformInfo()`). The page retries `connectNative` until
   it connects, then checks the step off.
4. **Pick a coding agent:** the same picker the side panel already has.
5. **Sign in** if the agent says it isn't, using the sign-in card the side
   panel already has.
6. **Allow User Scripts:** a button that opens site-modder's page in
   `chrome://extensions`. The extension already notices when it's turned on.

The side panel should show the same checklist until everything is done.

Also needed:

- **Installer** per OS: copy Agent Bridge somewhere stable (e.g.
  `~/Library/Application Support/site-modder/`) and register the native
  messaging host (a JSON file on macOS and Linux, a registry key on Windows).
- **Code signing:** macOS blocks unsigned downloaded executables, so this needs
  an Apple Developer ID and notarization. Windows has the same issue
  (SmartScreen).
- **Version check:** Agent Bridge and the extension report their versions;
  show an update prompt when Agent Bridge is too old.
- **Uninstall:** removing the extension leaves Agent Bridge behind. Document
  how to remove it.

## 3. Browser tools for agents without MCP-over-ACP

The browser tools reach the agent through MCP-over-ACP. Claude Agent supports
it; Codex doesn't, so Codex can write mods but can't see the page (the side
panel says so). Options:

- A small stdio MCP server that Agent Bridge passes to the agent as an ordinary
  MCP server and that forwards tool calls back to Agent Bridge (works for any
  agent that supports stdio MCP servers).
- Or get MCP-over-ACP support added to codex-acp upstream.

Then check which other popular agents (Gemini CLI, Copilot, Cursor,
OpenCode) support it.

## 4. Test in real Chrome

Only tested with the fake extension (`npm run fake-extension`), a mock-up of
the side panel, or not at all:

- Per-tab toolbar badges.
- A complete real sign-in and sign-out, and signing in to agents other than
  Claude.
- The agent picker and download in the real side panel; auto-update with
  Claude Agent (only tested with Codex).
- The banner hiding by itself after turning on Allow User Scripts.
- Agent Bridge on Linux and Windows (zip handling, npm paths, musl).

## 5. Chrome Web Store

- Real icon (the current one is a placeholder).
- Store listing, screenshots, privacy disclosures, and justifications for the
  `userScripts`, `<all_urls>` and (after section 1) `nativeMessaging`
  permissions.

## Session history

Chats are saved to `~/.site-modder/sessions/<session id>.json` (agent, title,
URL, events). Add a history menu to the side panel that lists them and restores
one into the current tab, using ACP `session/load` or `session/resume` where
the agent supports them (Claude Agent does) so the agent remembers it too.

## Later

- **Working indicator:** an animation at the bottom of the chat while the agent
  works, as part of a design pass. The old status dot was removed.
- **"Starting agent" state:** removed for now; add back if starting is slow
  enough to need it.
- **Python-based agents:** registry agents distributed with `uvx` are hidden
  from the picker because Agent Bridge can't install them.

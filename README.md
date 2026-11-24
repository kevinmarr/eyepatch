# Eyepatch

Modify any website by chatting with a coding agent from Chrome's side panel.
The agent (Claude, Codex, Gemini CLI or any other ACP agent) runs on your
machine and talks to the extension through **Agent Bridge**, a small local
program, using the
[Agent Client Protocol](https://agentclientprotocol.com).

```
side panel ⇄ service worker ⇄ native messaging ⇄ Agent Bridge ⇄ ACP (stdio) ⇄ agent
                    │                          │
            runs browser tools ◀── MCP (stdio) ┘
            registers mods as user scripts ◀── watches ~/.eyepatch/mods
```

## Install

Chrome starts Agent Bridge itself when the extension needs it (native
messaging), and stops it when Chrome quits. Nothing listens on a port.

1. Install the extension. Until it's in the Chrome Web Store: download this
   repo ([zip](https://github.com/kevinmarr/eyepatch/archive/refs/heads/main.zip)),
   open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick the `extension/` folder.
2. Chrome opens Eyepatch's Settings page, which doubles as setup. Its first
   step is installing Agent Bridge with one command. On macOS or Linux:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/kevinmarr/eyepatch/main/install.sh | sh
   ```

   On Windows, in PowerShell (not yet tested):

   ```powershell
   irm https://raw.githubusercontent.com/kevinmarr/eyepatch/main/install.ps1 | iex
   ```

   It downloads the latest [release](https://github.com/kevinmarr/eyepatch/releases),
   checks it against the release's checksums, puts it in
   `~/Library/Application Support/Eyepatch` (macOS), `~/.local/share/eyepatch`
   (Linux) or `%LOCALAPPDATA%\Eyepatch` (Windows), and registers it with every
   Chromium-based browser. The command in Settings installs the exact version
   that Eyepatch talks to (`EYEPATCH_VERSION=…`); without it you get the latest.
   After that, Eyepatch updates Agent Bridge itself (see
   [Updates](#updates)).
3. Settings then links to **Allow User Scripts** (mods need it) and installs
   a coding agent.
4. Click the toolbar icon to open the side panel and ask for a change.

Agent Bridge shows up as `eyepatch-agent-bridge` in Activity Monitor or Task
Manager while Chrome runs it. Each Chrome profile (or browser) with Eyepatch
runs its own Agent Bridge; they share `~/.eyepatch` (mods, chats and installed
agents).

### Uninstall

Removing the extension leaves Agent Bridge behind. To remove it too, on macOS:

```bash
~/Library/Application\ Support/Eyepatch/eyepatch-agent-bridge uninstall && rm -rf ~/Library/Application\ Support/Eyepatch
```

On Linux the folder is `~/.local/share/eyepatch`; on Windows,
`%LOCALAPPDATA%\Eyepatch`. Delete `~/.eyepatch` as well to remove your mods,
chats and the agents Eyepatch installed.

### From source

With [Bun](https://bun.sh), register the dev host once, then run Agent Bridge
in a terminal:

```bash
cd agent-bridge && bun install && bun run register:dev
```

```bash
bun run dev
```

`register:dev` points the browsers at a small shim that connects to the Agent
Bridge `bun run dev` runs (see [Dev loop](#dev-loop)). To have Chrome run a
standalone build instead, `bun run build`, then run
`dist/<platform>/eyepatch-agent-bridge install`. Load the extension unpacked as above.

## Tabs and chats

Each tab has its own side panel and its own chat. Switching tabs hides the
panel, and switching back shows it again with the conversation intact.
Several tabs can have chats going at once, each with its own agent and model,
and each agent's browser tools act only on its own tab. A chat continues if
the tab navigates to another page. Closing the tab ends the chat; it's saved
in `~/.eyepatch/sessions/`.

Tabs using the same agent share one copy of it running in Agent Bridge. An
agent that no open tab uses is stopped.

The ⋮ menu in the side panel lists the mods for the page you're on (with an
on/off switch each), your recent chats, and Settings. Clicking a past chat
restores it into the tab. Agents that can reopen a conversation over ACP
(Claude Agent and Codex do) carry on where it left off; others show the old
chat and start a new conversation with your next message.

## Agents

Agents are installed and removed on the Options page (right-click the toolbar
icon → **Options**). New tabs start with the agent you installed or picked
most recently. The list comes from the [ACP registry](https://agentclientprotocol.com/get-started/registry),
the same one Zed uses. Like Zed, Eyepatch installs its own copy of the agent
you pick in `~/.eyepatch/agents/<id>/<version>`, so it always has a version
that works with ACP:

- Agents published as downloads (Claude Agent, Cursor, OpenCode, …) are
  downloaded and checked against the registry's checksum.
- Agents published as npm packages (Codex, Gemini CLI, GitHub Copilot, …) are
  installed and run with Bun. Agent Bridge is itself a Bun executable that can
  act as `bun`, so neither Node nor npm is needed. A few npm agents don't run
  on Bun (Nova, Qoder, MiniMax Code) and aren't offered.
- When the registry lists a newer version, it's installed in the background and
  used once the agent is idle. The old copy is then removed.

Copies can be large: Claude Agent is about 200 MB to download and 425 MB on
disk, since it includes Claude Code. Agents usually share sign-in with their
regular install, so if you already use one you're probably signed in.

To start a new chat with a different agent, click the agent's name at the top
of the side panel and pick one of your installed agents; **Add more agents**
opens the Options page. The model
menu under the message box is per tab too; the model you pick last for an
agent is what its new chats start with.

The browser tools reach every agent as an ordinary stdio MCP server named
`eyepatch`, which ACP requires all agents to support. The agent starts
`eyepatch-agent-bridge mcp` (Agent Bridge's own executable) for each chat; it's only a
pipe to Agent Bridge over a local socket (`~/.eyepatch/tools-<pid>.sock`,
owner-only),
with a per-chat token that ties its tool calls to that chat's tab.

## Signing in

Eyepatch uses your agent's existing sign-in; it doesn't manage credentials.
If you're already signed in to Claude Code or Codex, there's nothing to do.

The Options page lists each installed agent with whatever account it reports
(Claude Agent reports one; Codex doesn't) and **Reauthenticate** in its ⋮ menu.
Its sign-in options come from the agent over ACP, so this works for any ACP agent.
Some the agent runs itself. Others are commands Agent Bridge runs, relaying the
output (with clickable links) and a box to paste a code back. While the
Options page is open, Agent Bridge keeps every installed agent running so they
can report their status.

If an agent reports it's signed out, the side panel shows an **Authenticate**
button that opens the Options page at that agent. There, **Check again**
restarts the agent so it re-reads its credentials, for when you signed in
somewhere else (e.g. in a terminal). Signing in through a command also
restarts the agent; if a tab is mid-reply with it, the restart waits for the
reply to finish.

## Working in the background

Agents keep working when the side panel is closed or you switch tabs. When
you're not watching a tab's panel, Chrome notifications (naming the tab) tell
you when its agent:

- finishes a turn,
- needs permission, or
- needs you to switch back to a tab so it can take a screenshot.

Clicking a notification brings up that tab with its side panel open.

Each tab's toolbar badge shows the same thing at a glance: a red `!` when it
needs you, a blue `•••` while its agent is working, and a green `✓` when it has
finished and you haven't looked yet. Otherwise it shows how many mods are
running on the page, in gray.
On macOS, Chrome itself needs notification permission (System Settings →
Notifications → Google Chrome).

## Mods

Each mod is one file in `~/.eyepatch/mods/`, in a format that userscript
managers already use, so mods move between Eyepatch and those managers
unchanged:

- `<id>.user.css` is a [UserCSS](https://github.com/openstyles/stylus/wiki/Writing-UserCSS)
  style, as Stylus uses: a `/* ==UserStyle== */` header, then CSS in
  `@-moz-document` blocks that say where it applies.
- `<id>.user.js` is a userscript, as Tampermonkey, Violentmonkey and
  Greasemonkey use: a `// ==UserScript==` header (`@match`, `@grant`, …),
  then the script.

The agent's working directory is `~/.eyepatch/mods`, and `CLAUDE.md`/`AGENTS.md`
there describe the formats. Whether each mod is on is kept in
`~/.eyepatch/mods-state.json`, not in the file.

The Options page lists every mod by site (mods for several sites or every
site under **Other mods**), with an on/off switch, show-in-folder and delete (deleted mods move to `~/.eyepatch/trash/`), and
**Import a mod** for `.user.js` and `.user.css` files. Opening a `.user.js` or
`.user.css` URL, for example Greasy Fork's Install button, opens Settings and
offers to install it. You can also drop files into the folder.

Files apply live. Styles hot-swap in every open tab, including when they're
turned on or off. A script change reloads the tab
whose agent made it, not other tabs on the same site (they pick it up when they
next load). Edits you make by hand, or with Claude Code in a terminal, reload
every matching tab.

### Userscript support

Scripts run the way userscript managers run them: inside a function, after
their `@require` files (downloaded once into `~/.eyepatch/cache/`, checked
against any `#sha256=…`). Supported:

- **Where:** `@match`, `@exclude-match`, `@include` and `@exclude` (globs, `.tld`
  and `/regexes/`), `@run-at`, `@noframes`.
- **World:** as in Tampermonkey, a script that grants nothing runs in the page's
  own JS world, and one with grants runs in an isolated world that sees only the
  DOM. Each script gets its own isolated world, so scripts can't see each
  other's globals. `@inject-into page|content` (Violentmonkey) and `@sandbox`
  (Tampermonkey) choose explicitly.
- **GM API** (`GM_*` and `GM.*`): `addStyle`, `addElement`, `getValue`,
  `setValue`, `deleteValue`, `listValues`, `getValues`, `setValues`,
  `deleteValues`, `addValueChangeListener` and `removeValueChangeListener`
  (stored in the extension, synced across tabs, ready at `document-start`),
  `xmlhttpRequest` (made by the extension, so cross-origin, limited to the
  page's host and `@connect` hosts, including after redirects),
  `registerMenuCommand` and `unregisterMenuCommand` (listed under the mod in the
  side panel's menu), `openInTab` (http and https), `notification`,
  `setClipboard`, `getResourceText`, `getResourceURL`, `info` and `log`.
  `bun run test:gm` checks them against Violentmonkey.
- **Not supported:** other `GM_` functions (`GM_download`, `GM_cookie`, …) throw
  an error saying so, and Settings shows the grant as unsupported.
  `unsafeWindow` is the isolated world's `window`; use `@grant none` or
  `@inject-into page` for page globals. `@updateURL` updates aren't checked.
  `GM_xmlhttpRequest` can't set forbidden headers (`Cookie`, `User-Agent`, …),
  and a redirect to a host not in `@connect` is made but its response withheld.

UserCSS styles must be plain CSS: `@var` defaults become CSS custom properties,
and preprocessors (`@preprocessor stylus`/`less`) aren't supported.

## Dev loop

- **Agent Bridge:** `bun run dev` runs it in your terminal with its log on
  screen, restarting when its source changes. Chrome reaches it through the
  shim `bun run register:dev` registered, so the extension reloading doesn't
  restart it or your agents. If it isn't running, Settings and the side panel
  say so. Without dev mode (a build Chrome starts itself), the log is in
  `~/.eyepatch/logs/agent-bridge.log`.
- **Extension:** while `bun run dev` runs, saving any file in `extension/`
  calls `chrome.runtime.reload()`, so you never have to visit
  `chrome://extensions`. Reopen the side panel after a reload.
- **Build:** `bun run build` makes a standalone executable for this computer
  in `dist/` (`--all` for every platform). It includes the Bun runtime, and its
  modes are `install`, `uninstall`, `dev`, `mcp`, and the native messaging host
  Chrome starts.
- **UI without Chrome:** serve `extension/` over HTTP (e.g.
  `python3 -m http.server -d extension`) and open `sidepanel.html?demo` for a
  canned chat with every Markdown element, tool calls and a permission request
  (send a message to watch a reply stream in; include "slow" to stream word by
  word), `options.html?demo` (or `?demo=setup`, `?demo=updating`,
  `?demo=update_failed`, `?demo=extension_outdated`, plus `&os=win`) for
  Settings, and
  `design.html` for every component. The design rules are in
  `.claude/skills/eyepatch-ui`.
- **Without Chrome:** `bun run fake-extension "make the h1 red"` starts an
  Agent Bridge and drives it with canned page data. Add `FAKE_AGENT=claude-acp` (any registry
  id) to pick and install that agent first.
- **Tests:** `bun test` checks match patterns, mod parsing, the native
  messaging format, and Agent Bridge end to end as Chrome runs it (with a fake
  agent using the browser tools). `EYEPATCH_TEST_BINARY=dist/<platform>/eyepatch-agent-bridge
  bun test` runs that against a build. `bun run test:e2e` loads the extension
  in Playwright's Chromium, which starts a real Agent Bridge (registered as
  the test profile's native messaging host), and checks that mods run: styles,
  hot swap, userscripts and their GM functions, menu commands, install from a
  URL, and import. `bun run test:gm` runs `scripts/gm/suite.user.js` and
  compares every result with `scripts/gm/reference.json`, recorded from
  Violentmonkey (`bun run test:gm --reference <unpacked Violentmonkey MV3>`
  records it again). Differences on purpose are in
  `scripts/gm/expected-differences.json`. `bun run test:update` builds an
  older, the current and a newer Agent Bridge, serves the current one as a
  fake release (`EYEPATCH_RELEASES_URL`), and checks in Chromium that the
  older one updates itself and the newer one is refused. All three need
  Playwright installed.

## Updates

The extension updates from the Chrome Web Store. It talks to exactly one
Agent Bridge version, `BRIDGE_VERSION` in `extension/background.js`, so the
two never need to understand each other's older or newer messages. Agent
Bridge's first message says its version (that message never changes), and the
extension checks it before sending or reading anything else:

- **Older:** the extension asks Agent Bridge to update itself to exactly
  `BRIDGE_VERSION`. It downloads that GitHub release, checks it against the
  release's `SHA256SUMS`, on macOS checks it's signed by the same Apple team
  as itself, checks it reports that version, and replaces its own executable.
  The extension then restarts it.
- **Same:** carry on.
- **Newer** (another browser's newer Eyepatch updated it): the extension asks
  the Web Store for its own update and reloads into it. If there isn't one
  yet, chat stops working and Settings and the side panel say so; mods that
  were already installed keep running. It tries again later.

Agent Bridge running from source is always accepted. Since all browsers share
one Agent Bridge, someone with Eyepatch in two browsers may see the newer case
for a moment after one of them updates.

Chrome doesn't apply an extension update while the service worker is busy,
and the port to Agent Bridge keeps it busy, so the extension reloads into an
update itself once no side panel is open and no agent is working.

## Releasing

Agent Bridge releases are built by `.github/workflows/release.yml`. To release
one, bump `version` in `agent-bridge/package.json`, commit, then push a
matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

It builds every platform, signs and notarizes the macOS builds, and publishes
a GitHub release with `SHA256SUMS`. Running the workflow by hand only builds.

The Apple secrets the workflow lists live in a GitHub environment named
`release` (Settings → Environments), set to require your approval and to
allow only `v*` tags and `main`, so each run that signs waits for you to
approve it. Signing happens in its own job, which runs nothing but Apple's
tools on the built executables. Actions are pinned to commits; update them
by hand when a run warns about them.

An extension release that needs the new Agent Bridge sets `BRIDGE_VERSION` to
it. **Publish the Agent Bridge release before uploading that extension
version**, or its users' updates will fail until it's there. Extension
releases that don't change `BRIDGE_VERSION` leave Agent Bridge alone.

## Chrome Web Store

`PRIVACY.md` is the privacy policy the store listing links to.

- `bun run package:extension` zips `extension/` into `agent-bridge/dist/`
  without the demo files and the manifest's `key` (the store rejects it). It
  refuses if `BRIDGE_VERSION` has no GitHub release yet. For the first upload
  only, add `--key /path/to/key.pem` so the store keeps the extension ID.

## Config (env vars)

| Var | Default | |
| --- | --- | --- |
| `EYEPATCH_HOME` | `~/.eyepatch` | Mods live in `$HOME/mods` |
| `EYEPATCH_AGENT` | the agent picked in the side panel | Run this ACP agent command instead, e.g. `gemini --acp` |

## Security notes

- Page content is untrusted input to an agent that runs on your machine. File
  edits in the mods dir are auto-accepted. Read-only browser tools and
  `reload_tab` run without asking. `run_js` and `navigate` always ask in the side panel, even with
  agents that approve tool calls themselves (Codex); shell commands and
  anything else ask when the agent asks.
- Only Eyepatch can start Agent Bridge: its native messaging manifest allows
  one extension ID (`ilbbppjdddgjalodmdcmgdigaakgblpe`, fixed by the `key` in
  `extension/manifest.json`). It talks to Chrome over stdin and stdout, and
  nothing listens on a network port. The browser tools' socket and the dev
  socket are owner-only.

## License

MIT. See [LICENSE](LICENSE).

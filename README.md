# site-modder

Modify any website by chatting with a coding agent from Chrome's side panel.
The agent (Claude, Codex, Gemini CLI or any other ACP agent) runs on your
machine and talks to the extension through **Agent Bridge**, a small local
program, using the
[Agent Client Protocol](https://agentclientprotocol.com).

```
side panel ⇄ service worker ⇄ WebSocket ⇄ Agent Bridge ⇄ ACP (stdio) ⇄ agent
                    │                          │
            runs browser tools ◀── MCP-over-ACP ┘
            registers mods as user scripts ◀── watches ~/.site-modder/mods
```

## Setup

1. Start Agent Bridge (Node 22+):

   ```bash
   cd agent-bridge && npm install && npm start
   ```

2. Load the extension: open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked** and pick the `extension/` folder.
3. On site-modder's **Details** page, turn on **Allow User Scripts**. Mods need it.
4. Click the toolbar icon to open the side panel, pick a coding agent, and ask
   for a change.

## Agents

The first time you open the side panel, it asks you to pick a coding agent.
The list comes from the [ACP registry](https://agentclientprotocol.com/get-started/registry),
the same one Zed uses. Like Zed, site-modder installs its own copy of the agent
you pick in `~/.site-modder/agents/<id>/<version>`, so it always has a version
that works with ACP:

- Agents published as downloads (Claude Agent, Cursor, OpenCode, …) are
  downloaded and checked against the registry's checksum.
- Agents published as npm packages (Codex, Gemini CLI, GitHub Copilot, …) are
  installed with the npm that came with Agent Bridge's Node.
- When the registry lists a newer version, it's installed in the background and
  used once the agent is idle. The old copy is then removed.

Copies can be large: Claude Agent is about 200 MB to download and 425 MB on
disk, since it includes Claude Code. Agents usually share sign-in with their
regular install, so if you already use one you're probably signed in.

To switch, click the agent's name in the header and choose **Change agent**.
Switching starts a new conversation.

The browser tools reach the agent over MCP-over-ACP. Agents that don't support
it (Codex, for now) can still write mods but can't see the page, and the side
panel says so.

## Signing in

site-modder uses your agent's existing sign-in; it doesn't manage credentials.
If you're already signed in to Claude Code, there's nothing to do.

If the agent reports it's signed out, the side panel says so and offers:

- **Check again**, after you've signed in the way you normally do (for
  example in your terminal).
- **The agent's own sign-in options**, listed by the agent over ACP, so this
  works for any ACP agent. Some the agent runs itself. Others are commands
  Agent Bridge runs, relaying the output (with clickable links) and a box to
  paste a code back. For Claude Agent these are "Claude
  Subscription" and "Anthropic Console".

Click the agent's name in the header to see the signed-in account, sign in
another way, or sign out. Signing out signs the agent out on this computer,
which can include using it outside site-modder.

## Working in the background

The agent keeps working when the side panel is closed or you switch tabs. Its
browser tools stay on the tab you sent the message from. When you're not
watching the panel, Chrome notifications tell you when the agent:

- finishes a turn,
- needs permission (Allow and Deny buttons are on the notification), or
- needs you to switch back to a tab so it can take a screenshot.

The toolbar badge shows the same thing at a glance: `…` while it's working,
`!` when it needs you, and `✓` when it has finished and you haven't looked yet.
On macOS, Chrome itself needs notification permission (System Settings →
Notifications → Google Chrome).

## Mods

Each mod is a folder in `~/.site-modder/mods/<id>/` with `mod.json`, and
optionally `mod.css` and `mod.js`. The agent's working directory is
`~/.site-modder/mods`, and `CLAUDE.md`/`AGENTS.md` there describe the format.
Files apply live: CSS hot-swaps in open tabs, and a JS change reloads matching
tabs. You can edit mods by hand, or with Claude Code in a terminal, and they
apply the same way.

## Dev loop

- **Extension:** while Agent Bridge runs, saving any file in `extension/`
  calls `chrome.runtime.reload()`, so you never have to visit
  `chrome://extensions`. Reopen the side panel after a reload.
- **Agent Bridge:** `npm run dev` restarts on change. The extension reconnects by
  itself.
- **Without Chrome:** `npm run fake-extension -- "make the h1 red"` drives the
  Agent Bridge with canned page data. Add `FAKE_AGENT=claude-acp` (any registry
  id) to pick and install that agent first.

## Config (env vars)

| Var | Default | |
| --- | --- | --- |
| `SITE_MODDER_PORT` | `7457` | The extension currently hardcodes 7457 |
| `SITE_MODDER_HOME` | `~/.site-modder` | Mods live in `$HOME/mods` |
| `SITE_MODDER_AGENT` | the agent picked in the side panel | Run this ACP agent command instead, e.g. `gemini --acp` |
| `SITE_MODDER_EXTENSION_ID` | any extension | Only accept connections from this extension ID |

## Security notes

- Page content is untrusted input to an agent that runs on your machine. File
  edits in the mods dir are auto-accepted. Read-only browser tools run without
  asking. `run_js`, `reload_tab`, shell commands and anything else still ask in
  the side panel.
- The WebSocket listens on 127.0.0.1 only and rejects any Origin that isn't a
  `chrome-extension://` URL. Set `SITE_MODDER_EXTENSION_ID` to pin it to yours.

## License

MIT. See [LICENSE](LICENSE).

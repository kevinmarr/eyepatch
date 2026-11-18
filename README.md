# site-modder

Modify any website by chatting with a coding agent from Chrome's side panel.
The agent (Claude Code by default) runs on your machine and talks to the
extension through a small local companion using the
[Agent Client Protocol](https://agentclientprotocol.com).

```
side panel ⇄ service worker ⇄ WebSocket ⇄ companion ⇄ ACP (stdio) ⇄ claude-agent-acp
                    │                          │
            runs browser tools ◀── MCP-over-ACP ┘
            registers mods as user scripts ◀── watches ~/.site-modder/mods
```

## Setup

1. Start the companion (Node 22+; uses your existing Claude Code login):

   ```bash
   cd companion && npm install && npm start
   ```

2. Load the extension: open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked** and pick the `extension/` folder.
3. On site-modder's **Details** page, turn on **Allow User Scripts**. Mods need it.
4. Click the toolbar icon to open the side panel and ask for a change.

## Signing in

The side panel signs the agent in using whatever the agent offers over ACP,
so it works for any ACP agent, not just Claude:

- **Sign-in methods the agent lists.** Some it runs itself. Others are commands
  the companion runs, relaying the output (with clickable links) and a box to
  paste a code back. For Claude these are "Claude Subscription" and
  "Anthropic Console".
- **API key**, for agents whose key variable site-modder knows
  (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`). It's saved to
  `~/.site-modder/secrets.json` (readable only by you) and passed to the agent
  when it starts.
- **Status and sign-out.** Click the agent's name in the header to see the
  signed-in account, sign in another way, or sign out. Signing out signs the
  agent out on this computer, which can include using it outside site-modder.

If you're already signed in to Claude Code, there's nothing to do.

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

- **Extension:** while the companion runs, saving any file in `extension/`
  calls `chrome.runtime.reload()`, so you never have to visit
  `chrome://extensions`. Reopen the side panel after a reload.
- **Companion:** `npm run dev` restarts on change. The extension reconnects by
  itself.
- **Without Chrome:** `npm run fake-extension -- "make the h1 red"` drives the
  companion with canned page data.

## Config (env vars)

| Var | Default | |
| --- | --- | --- |
| `SITE_MODDER_PORT` | `7457` | The extension currently hardcodes 7457 |
| `SITE_MODDER_HOME` | `~/.site-modder` | Mods live in `$HOME/mods` |
| `SITE_MODDER_AGENT` | Claude via `claude-agent-acp` | Any ACP agent command, e.g. `gemini --experimental-acp` |
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

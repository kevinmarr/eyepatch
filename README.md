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

# Eyepatch privacy policy

Last updated: November 24, 2026

Eyepatch is a free, open source Chrome extension
([github.com/kevinmarr/eyepatch](https://github.com/kevinmarr/eyepatch)) for
modifying websites using your own local coding agent.

Eyepatch does _not_ collect any information about you: your identity, browsing activity, page content, agent chats, or mods. It does not collect analytics, usage data, or error reports.

## Data stored on your computer

Eyepatch writes your mods, saved chats, installed agents, and logs inside `~/.eyepatch` on your computer. Values your mods save are kept in Chrome's storage for the extension. Uninstalling the extension and deleting `~/.eyepatch` and Agent Bridge's folder (see the README's Uninstall section) removes them.

## Data sent to your AI provider

The agent you connect to Eyepatch can read the page in the tab where the chat takes place (but no other tabs). This includes the page text, HTML, address, title and screenshots, plus the messages and images you send. The privacy policy and
terms of your AI provider apply to usage in Eyepatch.

## Network requests

Eyepatch makes requests to the following services:
- The Agent Client Protocol registry (cdn.agentclientprotocol.com), to fetch the list of available ACP agents.
- This project's GitHub Releases (github.com), to download updates to Eyepatch Agent Bridge, the extension's companion program.
- Whatever your mods ask for: files a userscript names with `@require` or `@resource`, and requests it makes with `GM_xmlhttpRequest`.

## Contact

Questions or concerns: open an issue at
[github.com/kevinmarr/eyepatch/issues](https://github.com/kevinmarr/eyepatch/issues).
This policy's history is public in that repository.

# Eyepatch privacy policy

Last updated: November 24, 2026

Eyepatch is a free, open source Chrome extension
([github.com/kevinmarr/eyepatch](https://github.com/kevinmarr/eyepatch)) for
changing websites by chatting with a coding agent that runs on your own
computer.

## The developer receives none of your data

Eyepatch doesn't send your browsing, the pages you chat about, your chats or
your mods to the developer. It doesn't currently collect analytics, usage
statistics or error reports. If that changes, this policy will say so first.

## What leaves your computer

**To the AI provider of the agent you chose, when you chat.** When you ask
for a change in Eyepatch's side panel, the agent you picked (for example
Claude Agent, Codex or Gemini CLI) can read the page in that tab: its text,
HTML, address, title and screenshots, plus the messages and images you send.
The agent runs on your computer and sends your conversation to its provider
(for example Anthropic, OpenAI or Google) under your own account with them,
as it does when you use it on its own. That provider's privacy policy and
terms apply. Only the tab you're chatting in is read; other tabs aren't.

**Downloads Eyepatch makes.** None of these include your browsing or chats:

- The list of available agents, from the Agent Client Protocol registry
  (cdn.agentclientprotocol.com), and the agent you choose to install, from
  where that registry says it's published (for example GitHub or npm).
- Updates to Agent Bridge, Eyepatch's companion program, from this project's
  GitHub releases.
- What your mods ask for: files a userscript names with `@require` or
  `@resource`, and requests it makes with `GM_xmlhttpRequest`. Opening a
  `.user.js` or `.user.css` link downloads that script so you can choose
  whether to install it.

## What stays on your computer

Your mods, saved chats, the agents Eyepatch installed and a log are in
`~/.eyepatch`. Values your mods save are kept in Chrome's storage for the
extension. Uninstalling the extension and deleting `~/.eyepatch` and Agent
Bridge's folder (see the README's Uninstall section) removes them.

## Use of data

Eyepatch uses page content only to do what you ask in the chat. Nothing is
sold, used for advertising, or used for anything other than changing the
pages you ask about.

## Contact

Questions or concerns: open an issue at
[github.com/kevinmarr/eyepatch/issues](https://github.com/kevinmarr/eyepatch/issues).
This policy's history is public in that repository.

# Eyepatch privacy policy

Last updated: November 23, 2026

Eyepatch is a Chrome extension that changes websites by chatting with a
coding agent that runs on your own computer. It's free, open source
([github.com/kevinmarr/eyepatch](https://github.com/kevinmarr/eyepatch)),
and has no servers, accounts, analytics or ads. The developer receives none
of your data.

## What Eyepatch reads, and where it goes

When you chat with an agent in Eyepatch's side panel, the agent can use
Eyepatch's browser tools on that tab: read the page's text and HTML, find
elements, run JavaScript in it, take screenshots, read its console, reload
it, and open other pages in it. It can also see the page's address and
title, the messages and images you send, and elements you point at.

This goes from the extension to **Agent Bridge**, a program on your computer
that the extension talks to through Chrome's native messaging (nothing
listens on the network). Agent Bridge passes it to the **coding agent you
chose** (for example Claude Agent, Codex or Gemini CLI), which runs on your
computer and sends your conversation, including what it read from the page,
to its provider (for example Anthropic, OpenAI or Google). That happens under
your own account with that provider, and their privacy policy and terms
apply. Eyepatch doesn't send it anywhere else.

The agent's tools act only on the tab its chat is in. Tabs without a chat
aren't read.

## What's stored on your computer

- **Mods** (the userscripts and styles agents write for you, and ones you
  install) are files in `~/.eyepatch/mods`, and are registered with Chrome as
  user scripts. Values mods save with the userscript API are kept in the
  extension's storage.
- **Chats** are saved in `~/.eyepatch/sessions` so you can reopen them.
- **Agents** Eyepatch installs for you are in `~/.eyepatch/agents`; their
  sign-in details are kept by each agent, as it would on its own.
- A log of Agent Bridge's activity is in `~/.eyepatch/logs`.

Removing the extension and deleting `~/.eyepatch` and Agent Bridge's folder
(see the README's Uninstall section) removes all of it.

## Network requests Eyepatch itself makes

- The list of agents, from the Agent Client Protocol registry
  (cdn.agentclientprotocol.com), and the agent you choose to install, from
  where that registry says it's published (for example GitHub or npm).
- Agent Bridge updates, from this project's GitHub releases, when the
  extension needs a newer version.
- What mods ask for: files a userscript names with `@require` or `@resource`,
  and its `GM_xmlhttpRequest` requests. Opening a `.user.js` or `.user.css`
  link downloads that script so you can choose to install it.

None of these include your browsing or chats. The agents themselves make
their own requests, as described above.

## Use of data

Eyepatch uses what it reads only to do what you ask in the chat. Nothing is
sold, used for advertising, or used for anything unrelated to changing the
page you're chatting about.

## Contact

Questions or concerns: open an issue at
[github.com/kevinmarr/eyepatch/issues](https://github.com/kevinmarr/eyepatch/issues).
Changes to this policy are made in that repository, where its history is
public.

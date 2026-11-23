# Chrome Web Store listing

What to paste into each field of the developer dashboard. Images are in this
folder (`bun run store:images` in agent-bridge/ makes them again).

## Package

- Upload `agent-bridge/dist/eyepatch-<version>.zip` from
  `bun run package:extension`. For the **first upload only**, use
  `bun run package:extension --key /path/to/key.pem`, which adds the private
  key as `key.pem` so the store keeps the extension ID
  (`ilbbppjdddgjalodmdcmgdigaakgblpe`) that Agent Bridge allows. Check the
  ID the dashboard shows matches before submitting.

## Store listing

**Name:** Eyepatch (from the manifest)

**Summary** (from the manifest's description, max 132 characters):
Change how any website looks and works by chatting with a coding agent on your computer.

**Description:**

> Eyepatch lets you change any website by asking for it. Open the side panel,
> say what you want ("hide the sidebar", "make this table sortable", "add a
> dark mode"), and a coding agent writes a mod for the site: a userscript or
> style that runs every time you visit.
>
> The agent runs on your computer: Claude Agent, Codex, Gemini CLI, Cursor,
> GitHub Copilot or any other agent that speaks the Agent Client Protocol,
> signed in with your own account. Eyepatch installs and updates it for you.
> It reads the page, tries changes, takes screenshots to check its work, and
> saves the result as a mod you can switch on and off.
>
> • Works on any site. Each tab has its own chat and its own agent.
> • Mods are ordinary userscripts and UserCSS files in a folder on your
>   computer. Edit them yourself, share them, or install scripts from Greasy
>   Fork and similar sites.
> • Supports most of the Greasemonkey/Tampermonkey API (GM_getValue,
>   GM_xmlhttpRequest, GM_registerMenuCommand, …).
> • No Eyepatch account or servers. Your chats go only to the agent you chose.
>
> Eyepatch needs a small companion program, Agent Bridge, on your computer
> (macOS, Linux or Windows). The Settings page that opens after installing
> walks you through it with one command, and turning on Allow User Scripts.
>
> Open source: https://github.com/kevinmarr/eyepatch

**Category:** Developer Tools (or Tools: Eyepatch is for anyone who wants a
site to work differently, but writes code to do it)

**Language:** English

**Images:**
- Store icon: `store-icon-128.png`
- Screenshots (1280×800): `screenshot-1.png`, `screenshot-2.png`. These are
  made from the demo pages; real ones (the side panel over a real site, mid
  change) would be better.
- Small promo tile (440×280): `promo-small-440x280.png`

**Homepage URL:** https://github.com/kevinmarr/eyepatch
**Support URL:** https://github.com/kevinmarr/eyepatch/issues

## Privacy practices

**Single purpose:**
Eyepatch lets you change how websites look and work by chatting with a
coding agent that writes and installs userscripts (mods) for the site you're
on.

**Permission justifications:**

- **sidePanel:** The chat with the agent lives in Chrome's side panel, one per
  tab.
- **userScripts:** Mods are userscripts and user styles, written by the agent
  at the user's request or installed by the user. They're registered with the
  userScripts API so they run on the sites they're for.
- **tabs:** To know which tab each chat belongs to, show the page's title and
  address in the chat, find the open tabs a changed mod applies to (to reload
  them), and switch to a chat's tab when the agent needs it.
- **scripting:** The agent's browser tools read the page it's chatting about
  (text, HTML, matching elements, console messages) and run JavaScript there
  to try changes, and the user can point at an element to show the agent.
- **storage:** Values mods save with the userscript API (GM_setValue), mods'
  on/off state for the userscript runtime, and small UI preferences.
- **alarms:** To reconnect to Agent Bridge (the local companion program) if
  it isn't running yet, e.g. right after it's installed.
- **notifications:** To tell the user when an agent working in a background
  tab finishes or needs their attention (e.g. a permission request).
- **nativeMessaging:** Eyepatch's agents run in Agent Bridge, a program on the
  user's computer. Native messaging is how the extension starts it and talks
  to it; nothing listens on the network.
- **declarativeNetRequestWithHostAccess:** Opening a `.user.js` or `.user.css`
  link (like Greasy Fork's Install button) is redirected to Eyepatch's install
  page, as userscript managers do, instead of downloading the file.
- **Host permission `<all_urls>`:** Users can change any website, so mods and
  the agent's tools need to work on whichever site they choose. Pages are read
  only for a tab where the user is chatting with an agent, and mods only run
  on the sites they declare.

**Are you using remote code?** No. The extension's own code is all in the
package. Userscripts (including libraries a userscript names with `@require`)
are user content: written by the agent at the user's request or installed by
the user, and run through the userScripts API, as in other userscript
managers.

**Data usage** (what to tick):

- **Website content: yes.** When the user chats about a page, the agent reads
  its text, HTML and screenshots. It goes to the coding agent the user chose,
  running on their computer, which sends it to that agent's provider under the
  user's own account.
- Everything else (personally identifiable information, health, financial,
  authentication, personal communications, location, web history, user
  activity): **no**. Eyepatch doesn't collect these. (Page content can contain
  anything the page shows, which is covered by website content.)

Certify all three: not sold to third parties, not used or transferred for
purposes unrelated to the single purpose, not used for creditworthiness or
lending.

**Privacy policy URL:**
https://github.com/kevinmarr/eyepatch/blob/main/PRIVACY.md

## Distribution

- Visibility: **Unlisted**
- Regions: all

# Firefox with Pro Searching

Lets Claude search and read the web through the copy of **Firefox already installed on your
computer**, signed in as you.

Everything happens locally. There is no server of ours, no tunnel, no account to create, and
nothing you search is ever sent anywhere except to Google — by your own browser, exactly as if
you had typed it yourself.

**Built by Bentaco the Destroyer.**

---

## What it does

| Tool | What it does |
|---|---|
| `google_search` | Searches Google through your own Firefox and returns the answer |
| `set_pro_searching` | Turns Google AI Pro searching on or off |
| `get_pro_searching` | Tells you whether Pro searching is on or off |
| `firefox_navigate` | Opens a URL in your Firefox |
| `firefox_get_text` | Returns the visible text of the current page |
| `firefox_read_page` | Returns the page structure, including clickable elements |
| `firefox_start` | Starts the local bridge if it isn't already running |

## Pro searching

Google AI Pro is a **paid Google plan**, so this is **off by default** — nobody is put into a
mode they may not be paying for, and nobody's results change without asking.

Turn it on by saying:

> turn on Pro searching

and off again with:

> turn off Pro searching

When it's on, searches run in Google AI Mode using **your own Google account and whatever plan
that account has**. Every answer states which mode produced it, so it is never ambiguous.

## Requirements

- **Windows**
- **Firefox** installed (from mozilla.org)
- Nothing else. Node ships with Claude, and the bridge is bundled.

## How it works

Claude talks to a small local bridge, which drives a **hidden, separate Firefox profile** so
your normal browsing is untouched — you can keep using Firefox while Claude works. Your cookies
are copied into that private profile so the hidden browser is signed in as you.

No inbound connections, no listening port exposed to the network, no tunnel, no remote server.

## Setup

Install it from the Claude connectors directory. There is no configuration. The first search
starts the bridge automatically.

## Privacy Policy

**This connector does not collect, store, transmit or sell any of your data.** There is no
server behind it and no analytics, telemetry, crash reporting or usage counting of any kind.
The author receives nothing.

- **Data collection:** none. There is no account, and no server operated by the author that
  your computer contacts.
- **Usage and storage:** your searches and the pages you visit stay on your computer and are
  never recorded or transmitted by this connector. A copy of your Firefox **cookie database**
  and of your Google **local storage** is placed in a private profile folder inside the
  connector's own installation directory, so the hidden browser is signed in as you. It never
  leaves your computer. Your saved **passwords are never copied** — the connector deliberately
  does not touch `key4.db` or `logins.json`. Screenshots, if taken, are written to a `shots`
  folder inside the connector's own directory and are never uploaded.
- **Third-party sharing:** none by this connector. The websites you visit — including Google —
  see the traffic your own browser sends them, exactly as in normal browsing, and their own
  privacy policies apply. No intermediary or third party is added.
- **Data retention:** nothing is retained anywhere off your machine. Uninstalling the connector
  removes its directory, and with it the copied cookies, the private profile and any
  screenshots. Nothing needs deleting from any server, because nothing was ever sent to one.
- **Children:** this connector is not directed at children and collects no information from
  anyone.
- **Contact:** bentaco42069@gmail.com

Full policy: [PRIVACY.md](PRIVACY.md)

## Support

bentaco42069@gmail.com

## Licence

MIT

# Privacy Policy — Firefox with Pro Searching

**Last updated: 17 August 2026**

## The short version

This connector does not collect, store, transmit or sell any of your data. There is no
server behind it. Everything it does happens on your own computer, in your own copy of
Firefox, under your own Google account.

## What this connector does

When Claude asks it to search or read a page, it drives the copy of Firefox already
installed on your computer. The page request goes from **your** browser to the website —
the same way it would if you had typed the address in yourself. The text of that page is
handed back to Claude so it can answer you.

## What is collected

**Nothing.** The author of this connector receives no data of any kind. There is no
analytics, no telemetry, no crash reporting, no usage counting, and no account to create.
There is no server operated by the author that your computer contacts.

## What stays on your computer

- **Your searches and the pages you visit.** They are never recorded or sent anywhere by
  this connector.
- **A copy of your Firefox cookie file.** So the hidden browser is signed in as you, your
  cookie database is copied into a private profile folder inside the connector's own
  installation directory. It never leaves your computer. Your saved passwords are **not**
  copied — the connector deliberately does not touch `key4.db` or `logins.json`.
- **Screenshots**, if a tool that takes one is used, are written to a `shots` folder inside
  the connector's own directory and are never uploaded.

## Who your data is shared with

Nobody, by this connector.

Note that the websites you visit — including Google — will see the traffic your browser
sends them, exactly as they would during normal browsing, and their own privacy policies
apply to that. This connector adds no intermediary and no third party of its own.

## Your Google account

Searches use whatever Google account is already signed in to your Firefox, and whatever
Google plan that account has. The connector does not create accounts, does not ask for
credentials, and never sees your password.

## Removing everything

Uninstall the connector from Claude. That removes the connector's directory, and with it
the copied cookie file, the private browser profile and any screenshots. Nothing is left
behind elsewhere on your system, and nothing needs deleting from any server, because
nothing was ever sent to one.

## Children

This connector is not directed at children and collects no information from anyone.

## Changes

Any future change to this policy will be published with the connector's next version, and
the date at the top will be updated.

## Contact

Questions about this policy can be sent to the author through the support contact listed
on the connector's directory page.

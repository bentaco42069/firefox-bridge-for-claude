# Firefox Bridge for Claude

Let a local AI coding agent (like [Claude Code](https://claude.com/claude-code)) **drive your Firefox** — navigate, read the page, click, type, screenshot, manage tabs — the same way the built-in tooling drives Chrome.

> ⚠️ **Community project.** Not affiliated with, endorsed by, or made by Anthropic or Mozilla. "Claude" and "Firefox" are trademarks of their respective owners; used here only to describe what this tool works with.

Firefox has no equivalent of the Chrome integration, so this fills the gap: a small **Firefox extension** talks to a tiny **local bridge**, and your agent drives it over the shell.

```
 your agent  ──shell──▶  local bridge  ◀──polls──  Firefox extension
 (ff.sh)                 (localhost:8765)           (your Firefox)
```

The bridge is a command mailbox: the agent drops a command in, the extension picks it up, does it in Firefox, and drops the result back. Everything is **localhost-only** — nothing is exposed off your machine.

## Why it's not sketchy

- **Nothing leaves your machine.** The bridge binds `127.0.0.1` only.
- **Loaded the clean way.** The extension is loaded through Firefox's Remote Debugging channel (RDP) — the same one Mozilla's own `web-ext` uses — which does **not** set the `navigator.webdriver` automation flag, so sites won't treat your browsing as a bot.
- **No account, no signing, no telemetry.** It's a local dev tool. Unsigned extensions can only be loaded temporarily on release Firefox, so it's re-loaded automatically at login (see below).

## Requirements

- Windows 10/11
- **Firefox** (regular release is fine)
- **[Git for Windows](https://git-scm.com/download/win)** — provides Git Bash, Perl, and curl (all used here)
- .NET Framework 4 (`csc.exe`) — already on every modern Windows; used once to compile the launcher

## Install

```bash
git clone <your-repo-url> firefox-bridge-for-claude
cd firefox-bridge-for-claude
bash install.sh
```

`install.sh` detects Firefox, Git Bash, the C# compiler, and your default Firefox profile; enables the localhost debug channel; compiles a **windowless** launcher; and installs it to run at login. Firefox then opens with the extension already loaded — every boot, no clicks.

## Use it

Drive it from any agent (or yourself) that can run shell commands:

```bash
bash ff.sh ping
bash ff.sh navigate '{"url":"https://example.com"}'
bash ff.sh read_page
bash ff.sh click '{"ref":12}'
bash ff.sh type '{"ref":3,"text":"hello","submit":true}'
bash ff.sh screenshot          # writes shots/shot-N.png, returns its path
bash ff.sh get_text
bash ff.sh tabs.list
```

Point your agent at this: *"You can drive my Firefox with `bash ff.sh <action> '<json>'` — actions: ping, navigate, get_text, read_page, click, type, scroll, screenshot, reload, back, forward, tabs.list/create/close/activate."*

| action | params |
| --- | --- |
| `ping` | – |
| `navigate` | `url` (or `"back"`/`"forward"`), `tabId?`, `timeout?` |
| `get_text` / `get_html` | `max?`, `tabId?` |
| `read_page` | `max?` – lists visible interactive elements, each tagged with a `ref` |
| `click` | `ref` \| `selector` \| `x,y` |
| `type` | `text`, `ref`\|`selector`, `submit?`, `replace?` |
| `scroll` | `direction` (up/down/left/right/top/bottom) or `x,y`, `amount?` |
| `screenshot` | `tabId?` – returns `png_path` |
| `reload` / `back` / `forward` | `tabId?` |
| `tabs.list` / `tabs.create` / `tabs.close` / `tabs.activate` | `url?` / `tabId?` |

`ref` values come from the most recent `read_page`.

## Autostart & uninstall

The compiled `FirefoxBridgeForClaude.exe` in your Startup folder brings everything up at login. To remove it: `bash uninstall.sh`.

## Security notes

This lets a local program **control your logged-in browser** — it can read pages and act as you on sites you're signed into. Only run it with an agent you trust, on a machine you control. The bridge has no auth (it relies on being localhost-only); don't expose port 8765 or 6000 off your machine.

## Limitations

- Can't act on privileged pages (`about:`, `addons.mozilla.org`, `view-source:`) — Firefox blocks extensions there.
- Heavy logged-in single-page apps (e.g. google.com's homepage) can be slow to report "loaded"; navigation is time-bounded so it never hangs.
- Windows-only for now (the launcher/installer are Windows-specific; the extension + bridge are cross-platform if you port those two scripts).

## License

MIT — see [LICENSE](LICENSE).

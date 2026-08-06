#!/usr/bin/env bash
# Firefox Bridge for Claude — one-shot launcher.
# Starts the bridge, opens Firefox with the clean debug channel, loads the
# extension via RDP. Safe to run repeatedly. Called by the compiled launcher.exe
# at login, or run directly: bash launch.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/config.sh" ] && source "$DIR/config.sh"
FIREFOX="${FBC_FIREFOX:-/c/Program Files/Mozilla Firefox/firefox.exe}"
BPORT="${FBC_PORT_BRIDGE:-8765}"
RPORT="${FBC_PORT_RDP:-6000}"

# 1) bridge — start detached if it isn't already listening
if ! curl -s --max-time 2 "http://localhost:$BPORT/health" >/dev/null 2>&1; then
  nohup perl "$DIR/bridge/bridge.pl" "$BPORT" >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

# 2) Firefox with the clean (non-automation) debug channel, if not running
if ! tasklist 2>/dev/null | grep -qi 'firefox\.exe'; then
  nohup "$FIREFOX" -start-debugger-server "$RPORT" >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

# 3) load the extension (rdp-install retries until the debug server is up)
EXT_WIN="$(cygpath -w "$DIR/extension" 2>/dev/null || echo "$DIR/extension")"
perl "$DIR/bridge/rdp-install.pl" "$RPORT" "$EXT_WIN" >/dev/null 2>&1

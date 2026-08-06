#!/usr/bin/env bash
# Firefox Bridge for Claude — uninstaller. Removes autostart and stops it.
STARTUP="$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup"
rm -f "$STARTUP/FirefoxBridgeForClaude.exe"
echo "Removed the autostart launcher from Startup."
echo "Stopping running pieces..."
taskkill //F //IM perl.exe >/dev/null 2>&1 || true
echo "The extension unloads on the next Firefox restart."
echo ""
echo "Left in place (remove by hand if you want a full clean):"
echo "  - the debug prefs appended to your Firefox profile's user.js"
echo "  - this project folder"

#!/usr/bin/env bash
# Installs LyricRoom.app into ~/Applications, wired to this repo checkout.
# Re-runnable. Does NOT enable the launchd auto-start agent -- see the note
# printed at the end if you want LyricRoom running before you open it.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$HOME/Applications/LyricRoom.app"

mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "${REPO}/deploy/macos/LyricRoom.app" "$DEST"
sed -i '' "s#@REPO@#${REPO}#g" "${DEST}/Contents/MacOS/LyricRoom"
chmod +x "${DEST}/Contents/MacOS/LyricRoom" "${REPO}/deploy/macos/open-app.command" "${REPO}/deploy/macos/launch-kiosk.command"

# Clear the quarantine flag so Gatekeeper doesn't block a locally-built app
# the first time it's opened (a code-signing prompt would otherwise appear
# since this bundle isn't signed/notarized).
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "installed ${DEST}"
echo "It's in Launchpad / Spotlight now as \"LyricRoom\" -- drag it to the Dock from there, or from Finder > Applications."
echo
echo "For it to also run as a background service (so it's already resolving lyrics"
echo "before you open the window), install the launchd agent:"
echo "  mkdir -p ~/Library/LaunchAgents"
echo "  sed \"s#REPLACE_WITH_REPO_PATH#${REPO}#g\" \"${REPO}/deploy/macos/com.lyricroom.daemon.plist\" > ~/Library/LaunchAgents/com.lyricroom.daemon.plist"
echo "  launchctl load ~/Library/LaunchAgents/com.lyricroom.daemon.plist"

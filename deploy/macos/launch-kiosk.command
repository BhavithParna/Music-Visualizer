#!/usr/bin/env bash
# macOS display launcher. `caffeinate -d` is the equivalent of the GNOME idle inhibit.
set -euo pipefail
PORT="${LYRICROOM_PORT:-8321}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
exec caffeinate -d "$CHROME" \
  --app="http://localhost:${PORT}/" \
  --kiosk \
  --user-data-dir="$HOME/Library/Caches/lyricroom-chrome" \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs --disable-infobars --no-first-run

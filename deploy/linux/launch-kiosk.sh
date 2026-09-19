#!/usr/bin/env bash
# Full-screen the visualizer on the room display and keep the screen awake.
set -euo pipefail

# --windowed opens a normal window instead of taking over the screen, which is
# what you want while developing or when the display is also your work machine.
WINDOWED=0
if [ "${1:-}" = "--windowed" ]; then WINDOWED=1; fi

PORT="${LYRICROOM_PORT:-8321}"
URL="http://localhost:${PORT}/"
PROFILE="${XDG_CACHE_HOME:-$HOME/.cache}/lyricroom-chrome"

# Wait for the daemon so Chrome never lands on a connection error page.
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:${PORT}/api/state"; then break; fi
  sleep 1
done

BROWSER=""
for candidate in google-chrome chromium chromium-browser brave-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then BROWSER="$candidate"; break; fi
done
if [ -z "$BROWSER" ]; then
  echo "No Chromium-family browser found." >&2
  exit 1
fi

# gnome-session-inhibit holds off the blanker and the idle logic for as long as
# the browser runs, which is the whole point of an always-on display.
INHIBIT=()
if command -v gnome-session-inhibit >/dev/null 2>&1; then
  INHIBIT=(gnome-session-inhibit --inhibit idle:suspend --reason "LyricRoom display")
fi

MODE=(--kiosk)
if [ "$WINDOWED" = "1" ]; then
  MODE=(--window-size=1600,1000 --window-position=80,60)
  INHIBIT=()
fi

exec "${INHIBIT[@]}" "$BROWSER" \
  --app="$URL" \
  "${MODE[@]}" \
  --user-data-dir="$PROFILE" \
  --ozone-platform-hint=auto \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate,MediaRouter \
  --no-first-run \
  --check-for-update-interval=31536000 \
  --password-store=basic

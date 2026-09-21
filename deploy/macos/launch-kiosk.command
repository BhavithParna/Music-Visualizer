#!/usr/bin/env bash
# macOS display launcher. `caffeinate -d` is the equivalent of the GNOME idle
# inhibit, and only makes sense for the always-on kiosk case.
#
# --windowed opens a normal window instead of taking over the screen, which is
# what you want while developing, when the display is also your work machine,
# or when launching LyricRoom as a regular app (see open-app.command).
set -euo pipefail

WINDOWED=0
if [ "${1:-}" = "--windowed" ]; then WINDOWED=1; fi

PORT="${LYRICROOM_PORT:-8321}"
URL="http://localhost:${PORT}/"
PROFILE="$HOME/Library/Caches/lyricroom-chrome"

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:${PORT}/api/state"; then break; fi
  sleep 1
done

CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
  if [ -x "$candidate" ]; then CHROME="$candidate"; break; fi
done
if [ -z "$CHROME" ]; then
  echo "No Chromium-family browser found in /Applications." >&2
  exit 1
fi

MODE=(--kiosk)
RUNNER=(caffeinate -d)
if [ "$WINDOWED" = "1" ]; then
  MODE=(--window-size=1600,1000 --window-position=80,60)
  RUNNER=()
fi

exec "${RUNNER[@]}" "$CHROME" \
  --app="$URL" \
  "${MODE[@]}" \
  --user-data-dir="$PROFILE" \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --no-first-run --check-for-update-interval=31536000 --password-store=basic

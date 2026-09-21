#!/usr/bin/env bash
# Entry point for the desktop launcher (deploy/linux/lyricroom.desktop): start
# the daemon if it isn't already running, then open the display as a normal
# window. Unlike launch-kiosk.sh this is for "an app you open and use", not
# the always-on room display, so it never takes over the screen -- use the
# fullscreen button in the corner (or `f`) for that.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${LYRICROOM_PORT:-8321}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/lyricroom"
mkdir -p "$STATE_DIR"

if ! curl -fsS -o /dev/null "http://localhost:${PORT}/api/state" 2>/dev/null; then
  cd "$REPO"
  nohup node --enable-source-maps apps/daemon/dist/index.js >> "$STATE_DIR/daemon.log" 2>&1 &
  disown
fi

exec "${REPO}/deploy/linux/launch-kiosk.sh" --windowed

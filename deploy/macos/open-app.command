#!/usr/bin/env bash
# Entry point for LyricRoom.app: start the daemon if it isn't already
# running, then open the display as a normal window. This is "an app you
# open and use", not the always-on room display -- use the fullscreen button
# in the corner (or `f`) for that, or launch-kiosk.command directly for the
# permanent-display setup.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${LYRICROOM_PORT:-8321}"
STATE_DIR="$HOME/Library/Logs/lyricroom"
mkdir -p "$STATE_DIR"

NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
if [ -z "$NODE" ]; then
  osascript -e 'display alert "LyricRoom" message "Node.js was not found. Install it (e.g. via Homebrew: brew install node) and try again."'
  exit 1
fi

if ! curl -fsS -o /dev/null "http://localhost:${PORT}/api/state" 2>/dev/null; then
  cd "$REPO"
  nohup "$NODE" --enable-source-maps apps/daemon/dist/index.js >> "$STATE_DIR/daemon.log" 2>&1 &
  disown
fi

exec "${REPO}/deploy/macos/launch-kiosk.command" --windowed

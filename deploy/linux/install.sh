#!/usr/bin/env bash
# Install and enable the two user services. Re-runnable.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"

for unit in lyricroom-daemon.service lyricroom-kiosk.service; do
  sed "s#%h/Documents/Music Visualizer#${REPO}#g" "${REPO}/deploy/linux/${unit}" > "${UNIT_DIR}/${unit}"
  echo "installed ${UNIT_DIR}/${unit}"
done

systemctl --user daemon-reload
systemctl --user enable --now lyricroom-daemon.service
echo
echo "Daemon enabled. Start the display with:"
echo "  systemctl --user enable --now lyricroom-kiosk.service"
echo "Or run it in a window right now:"
echo "  ${REPO}/deploy/linux/launch-kiosk.sh"

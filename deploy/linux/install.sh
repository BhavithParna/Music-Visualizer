#!/usr/bin/env bash
# Installs LyricRoom as an app you can launch from the app grid / dock, and
# lays down the user services for the always-on room display. Re-runnable.
#
# Nothing is auto-started: the launcher brings the daemon up on demand, and
# the services are opt-in (see the note printed at the end).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ---- services (installed, not enabled) --------------------------------------
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
for unit in lyricroom-daemon.service lyricroom-kiosk.service; do
  sed "s#%h/Documents/Music Visualizer#${REPO}#g" "${REPO}/deploy/linux/${unit}" > "${UNIT_DIR}/${unit}"
  echo "installed ${UNIT_DIR}/${unit}"
done
systemctl --user daemon-reload

# ---- icon -------------------------------------------------------------------
# Into the hicolor theme rather than referenced by path: the shell caches
# icons per path, so overwriting a file in place leaves the old one on screen.
ICON_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
for size in 192 512; do
  install -Dm644 "${REPO}/apps/renderer/public/icons/icon-${size}.png" \
    "${ICON_ROOT}/${size}x${size}/apps/lyricroom.png"
done
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true
echo "installed icon into ${ICON_ROOT}"

# ---- launcher ---------------------------------------------------------------
chmod +x "${REPO}/deploy/linux/open-app.sh" "${REPO}/deploy/linux/launch-kiosk.sh"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APP_DIR"
sed "s#@REPO@#${REPO}#g" "${REPO}/deploy/linux/lyricroom.desktop" > "${APP_DIR}/lyricroom.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" || true
echo "installed ${APP_DIR}/lyricroom.desktop"

echo
echo "LyricRoom is in the app grid now -- right-click it there to pin it to the dock."
echo
echo "For the always-on room display instead, enable the services:"
echo "  systemctl --user enable --now lyricroom-daemon.service"
echo "  systemctl --user enable --now lyricroom-kiosk.service"

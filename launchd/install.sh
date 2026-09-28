#!/usr/bin/env bash
# Installs a launchd agent that runs `moodle-tasks` daily at 08:00.
#
# Why launchd instead of `node-cron` (npm run schedule): node-cron only
# fires while its own node process keeps running, so it dies the moment
# the user logs out, reboots, or closes the terminal - which defeats the
# point of a *daily* reminder. launchd is the OS scheduler and survives
# all of that; `npm run schedule` (src/schedule/cron.js) is kept as a
# portable fallback for non-macOS or for testing without touching launchd.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd is macOS-only. On Linux, use 'npm run schedule' (node-cron) or a system cron job instead." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_PATH="$WORKDIR/bin/moodle-tasks.js"
NODE_PATH="$(command -v node)"
LABEL="com.moodle-task-fetcher"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/moodle-task-fetcher"

if [[ -z "$NODE_PATH" ]]; then
  echo "Could not find 'node' on PATH. Install Node.js first." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_DEST")"

sed \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__SCRIPT_PATH__|$SCRIPT_PATH|g" \
  -e "s|__WORKDIR__|$WORKDIR|g" \
  -e "s|__LOG_PATH__|$LOG_DIR|g" \
  "$SCRIPT_DIR/com.moodle-task-fetcher.plist.template" > "$PLIST_DEST"

# Unload first in case a previous version is already loaded, so re-running
# this script after an update doesn't fail with "already bootstrapped".
launchctl bootout "gui/$(id -u)" "$PLIST_DEST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "Installed launchd agent: $PLIST_DEST"
echo "Runs daily at 08:00. Logs: $LOG_DIR"
echo ""
echo "Uninstall with:"
echo "  launchctl bootout gui/$(id -u) $PLIST_DEST && rm $PLIST_DEST"

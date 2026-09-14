#!/usr/bin/env bash
# Inbox One dev launcher.
#
# Brings up the Sessions desktop build AND the companion webhook receiver so the
# webhook backend is fully live on startup with no additional user input: the app
# publishes the enrolled repos to `<userDataDir>/User/inboxOneWebhook/config.json`,
# and the companion reads that config and runs `gh webhook forward` for each repo,
# dropping deliveries into the directory the in-product FileDropReceiverAdapter
# watches. Nothing about the repos is hardcoded -- it follows the live enrollment.
#
# Usage: scripts/inbox-one-dev.sh [--user-data-dir DIR] [--extensions-dir DIR]

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_DATA_DIR="/tmp/inbox-dev-userdata"
EXT_DIR="/tmp/inbox-dev-ext"

while [ $# -gt 0 ]; do
	case "$1" in
		--user-data-dir) USER_DATA_DIR="$2"; shift 2 ;;
		--extensions-dir) EXT_DIR="$2"; shift 2 ;;
		*) echo "unknown arg: $1"; exit 1 ;;
	esac
done

echo "[inbox-one-dev] user-data-dir: $USER_DATA_DIR"

# 1) The Sessions desktop build (loads the in-product receiver + config writer).
VSCODE_SKIP_PRELAUNCH=1 DISPLAY="${DISPLAY:-:0}" setsid bash "$ROOT/scripts/code.sh" \
	--user-data-dir "$USER_DATA_DIR" --extensions-dir "$EXT_DIR" \
	</dev/null >/tmp/inbox-desktop.log 2>&1 &
echo "[inbox-one-dev] launched desktop build (log: /tmp/inbox-desktop.log)"

# 2) The companion webhook receiver (reads the app-published enrollment config).
setsid node "$ROOT/scripts/inbox-one-webhook.mjs" --user-data-dir "$USER_DATA_DIR" \
	</dev/null >/tmp/inbox-one-webhook.log 2>&1 &
echo "[inbox-one-dev] launched webhook companion (log: /tmp/inbox-one-webhook.log)"

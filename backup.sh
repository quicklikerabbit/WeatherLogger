#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

REMOTE_HOST="pi-logger"
REMOTE_DB="\$HOME/weather/sensors.db"
STAMP=$(date -u +%Y%m%d-%H%M%S)
REMOTE_TMP="/tmp/sensors-snapshot-$STAMP.db"
LOCAL_DIR="dashboard/backups"
LOCAL_FILE="$LOCAL_DIR/sensors-$STAMP.db"

mkdir -p "$LOCAL_DIR"

# Uses VACUUM INTO (not a raw file copy) since sensors.db runs in WAL mode —
# copying the .db file directly could grab it mid-checkpoint and miss data
# still sitting in the -wal file. VACUUM INTO also compacts the copy, which
# keeps the scp transfer small.
ssh "$REMOTE_HOST" "sqlite3 $REMOTE_DB \"VACUUM INTO '$REMOTE_TMP';\""
scp "$REMOTE_HOST:$REMOTE_TMP" "$LOCAL_FILE"
ssh "$REMOTE_HOST" "rm -f $REMOTE_TMP"

echo "Snapshot saved to $LOCAL_FILE"

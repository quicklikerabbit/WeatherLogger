#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

REMOTE_HOST="pi-logger"
REMOTE_DB="\$HOME/weather/sensors.db"
STAMP=$(date -u +%Y%m%d-%H%M%S)
REMOTE_TMP="/tmp/sensors-snapshot-$STAMP.db"
LOCAL_DIR="dashboard/backups"
LOCAL_FILE="$LOCAL_DIR/sensors-$STAMP.db"
LOCAL_PARTIAL="$LOCAL_FILE.partial"
KEEP_COUNT=20

mkdir -p "$LOCAL_DIR"

# Clean up the remote snapshot on any exit path, not just the happy one —
# without this, a failed scp leaves REMOTE_TMP behind on the Pi forever
# since `set -e` skips the rest of the script.
trap 'ssh "$REMOTE_HOST" "rm -f $REMOTE_TMP"' EXIT

# Uses VACUUM INTO (not a raw file copy) since sensors.db runs in WAL mode —
# copying the .db file directly could grab it mid-checkpoint and miss data
# still sitting in the -wal file. VACUUM INTO also compacts the copy, which
# keeps the scp transfer small.
ssh "$REMOTE_HOST" "sqlite3 $REMOTE_DB \"VACUUM INTO '$REMOTE_TMP';\""
# scp to a .partial name first and rename into place once complete, so the
# dashboard server (which globs for *.db) never picks up a half-written file.
scp "$REMOTE_HOST:$REMOTE_TMP" "$LOCAL_PARTIAL"
mv "$LOCAL_PARTIAL" "$LOCAL_FILE"

echo "Snapshot saved to $LOCAL_FILE"

# Keep only the KEEP_COUNT most recent snapshots — otherwise every run's
# .db file sits in $LOCAL_DIR forever, and the dashboard server rescans
# the whole directory on every request.
count=0
while IFS= read -r old_snapshot; do
  count=$((count + 1))
  if [ "$count" -gt "$KEEP_COUNT" ]; then
    rm -f "$old_snapshot"
  fi
done < <(ls -1t "$LOCAL_DIR"/sensors-*.db 2>/dev/null)

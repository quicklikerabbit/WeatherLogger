"""Shared test scaffolding — not a test module itself."""

import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO_ROOT / "schema.sql"

# So `import logger` / `import ec_publisher` work regardless of how the
# test is invoked (unittest discover, running the file directly, etc).
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def make_logger(logger_cls, tmp_dir):
    """A Logger wired to a fresh temp db with schema.sql applied — mirrors
    `sqlite3 ~/weather/sensors.db < schema.sql` on the Pi. Never connects
    to MQTT, so no broker is needed to run these tests."""
    db_path = Path(tmp_dir) / "sensors.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_PATH.read_text())
    conn.close()
    return logger_cls(db_path)

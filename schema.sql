CREATE TABLE readings (
    id          INTEGER PRIMARY KEY,
    device_id   TEXT    NOT NULL,
    metric      TEXT    NOT NULL,
    value       REAL    NOT NULL,
    recorded_at TEXT    NOT NULL,
    received_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- UNIQUE so a QoS-1 redelivery of the same reading (same device/metric/
-- timestamp) can be safely re-inserted with INSERT OR IGNORE instead of
-- creating a duplicate row.
CREATE UNIQUE INDEX idx_readings_lookup ON readings (device_id, metric, recorded_at);
CREATE INDEX idx_readings_time   ON readings (recorded_at);

CREATE TABLE deployments (
    id         INTEGER PRIMARY KEY,
    device_id  TEXT NOT NULL,
    location   TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    notes      TEXT
);
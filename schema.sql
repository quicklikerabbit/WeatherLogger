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

-- Multi-day weather forecast periods (e.g. "Tonight", "Monday"), issued as
-- a batch. Doesn't fit `readings` because a period isn't one scalar value:
-- it carries a high/low class, an optional probability of precip, and a
-- free-text summary. Deduped on (device_id, issued_at, period_name) so a
-- re-poll within the same forecast issue is a no-op.
CREATE TABLE forecast_periods (
    id           INTEGER PRIMARY KEY,
    device_id    TEXT    NOT NULL,
    issued_at    TEXT    NOT NULL,
    period_name  TEXT    NOT NULL,
    period_index INTEGER NOT NULL,
    temp_class   TEXT,
    temperature  REAL,
    pop          REAL,
    precip_type  TEXT,
    summary      TEXT,
    received_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_forecast_lookup ON forecast_periods (device_id, issued_at, period_name);
CREATE INDEX idx_forecast_issued ON forecast_periods (issued_at);

-- Air Quality Health Index: both the live observation and ECCC's own
-- multi-period forecast for the same station, distinguished by `kind`.
-- Kept out of `readings` since a forecast row isn't a past observation,
-- and mixing that distinction into `readings` would make its
-- (device_id, metric, recorded_at) uniqueness ambiguous between the two.
-- period_name defaults to '' (not NULL) for observation rows and the
-- dedup index relies on that, since SQLite treats NULL != NULL.
CREATE TABLE aqhi (
    id          INTEGER PRIMARY KEY,
    device_id   TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('observation', 'forecast')),
    valid_at    TEXT    NOT NULL,
    period_name TEXT    NOT NULL DEFAULT '',
    value       REAL    NOT NULL,
    received_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_aqhi_lookup ON aqhi (device_id, kind, valid_at, period_name);
CREATE INDEX idx_aqhi_time ON aqhi (valid_at);

-- Precipitation type for an hourly observation, decoded from Environment
-- Canada's SWOB-ML present-weather code. Kept out of `readings` since the
-- value is categorical text, not a numeric metric — `readings` requires
-- `value REAL NOT NULL`. The paired measurement (precipitation_mm) is a
-- normal numeric metric and lives in `readings` like temperature/humidity.
CREATE TABLE precip_type_readings (
    id           INTEGER PRIMARY KEY,
    device_id    TEXT    NOT NULL,
    recorded_at  TEXT    NOT NULL,
    precip_type  TEXT    NOT NULL CHECK (precip_type IN (
        'drizzle', 'rain', 'snow', 'mixed', 'freezing_rain',
        'ice_pellets', 'hail', 'thunderstorm'
    )),
    received_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_precip_type_lookup ON precip_type_readings (device_id, recorded_at);
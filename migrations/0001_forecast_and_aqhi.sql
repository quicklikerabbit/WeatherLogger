-- Adds forecast_periods and aqhi to an existing database that already has
-- readings and deployments (i.e. one created before these tables existed).
-- Safe to run once against a live database; does not touch existing tables
-- or data. schema.sql already includes these — this file exists only for
-- migrating a database that predates them.
--
-- Run it against the live db, e.g.:
--   sqlite3 ~/weather/sensors.db < migrations/0001_forecast_and_aqhi.sql          (on the Pi)
--   ssh pi-logger 'sqlite3 ~/weather/sensors.db' < migrations/0001_forecast_and_aqhi.sql   (from elsewhere)

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

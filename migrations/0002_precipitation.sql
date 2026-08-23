-- Adds precipitation data to an existing database created before it existed:
-- a precip_type column on forecast_periods, and a new precip_type_readings
-- table for the categorical type of an hourly observation. schema.sql
-- already includes both — this file exists only for migrating a database
-- that predates them. Precipitation amount (precipitation_mm) needs no
-- migration: it's a normal numeric metric in the existing `readings` table.
--
-- Run it against the live db, e.g.:
--   sqlite3 ~/weather/sensors.db < migrations/0002_precipitation.sql          (on the Pi)
--   ssh pi-logger 'sqlite3 ~/weather/sensors.db' < migrations/0002_precipitation.sql   (from elsewhere)

ALTER TABLE forecast_periods ADD COLUMN precip_type TEXT;

-- Kept out of `readings` since the value is categorical text, not a numeric
-- metric — `readings` requires `value REAL NOT NULL`.
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

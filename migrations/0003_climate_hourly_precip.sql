-- Precipitation switches source from SWOB-ML (real-time, unreviewed) to
-- Environment Canada's climate-hourly archive (Victoria Gonzales CS,
-- climate ID 1018611), which runs observations through the National
-- Climate Archive's QC pipeline before they're queryable. schema.sql
-- already reflects both changes below — this file exists only for
-- migrating a database that predates them.
--
-- Run it against the live db, e.g.:
--   sqlite3 ~/weather/sensors.db < migrations/0003_climate_hourly_precip.sql          (on the Pi)
--   ssh pi-logger 'sqlite3 ~/weather/sensors.db' < migrations/0003_climate_hourly_precip.sql   (from elsewhere)

-- precip_type came from decoding SWOB-ML's present-weather code, which the
-- climate-hourly archive has no equivalent of (its free-text weather
-- description field is unpopulated for automated stations like Gonzales
-- CS). No replacement source, so the table goes with it. Empty in
-- production as of this migration.
DROP TABLE IF EXISTS precip_type_readings;

-- QC flag from the upstream source, e.g. 'T' (trace) or 'E' (estimated) for
-- precipitation_mm. NULL for a clean value and for every metric whose
-- source carries no such flag at all.
ALTER TABLE readings ADD COLUMN quality_flag TEXT;

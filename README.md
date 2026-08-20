# WeatherLogger

A small MQTT-based data logger for a home weather station running on a
Raspberry Pi. Sensors (or, for now, a fake publisher) publish readings
over MQTT; a logger process subscribes and writes them into SQLite.

## How it fits together

- **Mosquitto** — MQTT broker, runs on the Pi.
- **`logger.py`** — subscribes to `sensors/+/reading` and `sensors/+/status`,
  writes readings into `sensors.db`. Runs on the Pi, connects to the
  broker at `localhost`.
- **`fake_publisher.py`** — simulates a few sensors (temperature, humidity,
  pressure, wind speed, PM2.5/PM10) with drifting values, for testing the
  logger without real hardware. Can run on any machine on the same network
  as the Pi (see `BROKER_HOST` below) — real sensor hardware isn't wired up
  yet.
- **`ec_publisher.py`** — polls Environment Canada's MSC Datamart hourly
  for Victoria's current conditions, forecast, and Air Quality Health
  Index, and republishes them as device `ec-victoria`. Real, externally-sourced
  data (as opposed to the fake publisher's simulated values) that also
  builds baseline history for the city before real hardware exists to
  compare it against.
- **`schema.sql`** — SQLite schema (`readings`, `forecast_periods`, `aqhi`,
  `deployments` tables).

Readings are deduplicated on `(device_id, metric, recorded_at)` via a
unique index, since the logger uses QoS 1 with a persistent MQTT session
and can receive the same message more than once after a reconnect.
`forecast_periods` and `aqhi` are deduplicated the same way, on their own
natural keys — see the comments in `schema.sql`.

### Topic scheme

Every publisher — real or fake — publishes under `sensors/<device-id>/<kind>`:

- `sensors/<device-id>/reading` — scalar metrics as a flat JSON object
  (`{"ts": ..., "temperature": ..., ...}`), stored one row per metric in
  `readings`.
- `sensors/<device-id>/status` — `online`/`offline`, retained, backed by
  a Last Will and Testament.
- `sensors/<device-id>/forecast` — multi-day weather forecast periods
  (EC only, so far), stored in `forecast_periods`.
- `sensors/<device-id>/aqhi` — Air Quality Health Index observation and
  forecast (EC only, so far), stored in `aqhi`.

EC is just another device (`ec-victoria`) publishing on this same scheme,
not a separate topic branch — `logger.py` doesn't know or care whether a
reading came from real hardware or from Environment Canada.

## Setup

On both the Pi and any machine that'll run `fake_publisher.py`:

```bash
python3 -m venv venv
source venv/bin/activate
pip install paho-mqtt
```

On the Pi, Mosquitto needs to accept connections from other devices on
the network (not just `localhost`). Check `/etc/mosquitto/conf.d/`:

```
listener 1883
allow_anonymous true
```

Create the database from the schema (on the Pi, once):

```bash
sqlite3 ~/weather/sensors.db < schema.sql
```

### Migrating an existing database

`schema.sql` is the full schema, for a fresh database only — running it
again against a database that already has tables will error on the ones
that already exist. If you already have a `sensors.db` and the schema has
grown since it was created, apply each numbered file under `migrations/`
that you haven't already run, in order:

```bash
sqlite3 ~/weather/sensors.db < migrations/0001_forecast_and_aqhi.sql          # on the Pi
ssh <hostname> 'sqlite3 ~/weather/sensors.db' < migrations/0001_forecast_and_aqhi.sql   # from elsewhere
```

Each migration file is additive and self-contained (new tables/indexes
only), safe to run once. There's no tracking table recording which ones
have already run — for a project this size that's more machinery than
it's worth — so just remember to run new ones once, in order, when you
pull an update that adds one.

## Running

On the Pi:

```bash
python logger.py
```

From another machine (or the Pi itself), to publish fake readings:

```bash
BROKER_HOST=<pi-ip> python fake_publisher.py
```

`BROKER_HOST` defaults to `localhost`, for running the publisher directly
on the Pi.

To publish real Environment Canada data for Victoria (no config needed —
site/station codes are hardcoded in `ec_publisher.py`, found via EC's own
site list and region directory listings):

```bash
BROKER_HOST=<pi-ip> python ec_publisher.py
```

It polls once immediately on startup, then hourly on the clock (with a
5-minute delay past the hour, since MSC's bulletins land a minute or two
after). `fake_publisher.py` and `ec_publisher.py` can run at the same
time — they're different device IDs and don't conflict.

## Future work

- Replace `fake_publisher.py` with real sensor hardware.
- Consider a second EC source (SWOB) for station-level observation
  precision once there's a real yard sensor to compare it against.

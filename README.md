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
- **`schema.sql`** — SQLite schema (`readings`, `deployments` tables).

Readings are deduplicated on `(device_id, metric, recorded_at)` via a
unique index, since the logger uses QoS 1 with a persistent MQTT session
and can receive the same message more than once after a reconnect.

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

## Future work

- Replace `fake_publisher.py` with real sensor hardware.

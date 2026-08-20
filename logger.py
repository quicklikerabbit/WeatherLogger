#!/usr/bin/env python3
"""
Logger — subscribes to sensor topics and writes readings to SQLite.

Uses a persistent session so the broker queues QoS-1 messages while
this process is down, and delivers them on reconnect. That means
restarting the logger to deploy a change doesn't lose data.

Usage:
    source ~/weather/venv/bin/activate
    python logger.py

Stop with Ctrl+C.
"""

import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt

from timeutils import utc_now_iso

# --------------------------------------------------------------------
# Config
# --------------------------------------------------------------------

BROKER_HOST = "localhost"
BROKER_PORT = 1883
DB_PATH = Path.home() / "weather" / "sensors.db"

# Fixed client ID. This is what lets the broker recognise us across
# restarts and hold our queued messages. Change it and you get a new,
# empty session.
CLIENT_ID = "logger-main"

READING_TOPIC = "sensors/+/reading"
STATUS_TOPIC = "sensors/+/status"
FORECAST_TOPIC = "sensors/+/forecast"
AQHI_TOPIC = "sensors/+/aqhi"

# Keys in the payload that aren't measurements.
NON_METRIC_KEYS = {"ts"}

# --------------------------------------------------------------------


def is_valid_recorded_at(value):
    """True if value is a string in the same ISO-8601 form utc_now_iso() produces."""
    if not isinstance(value, str):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


class Logger:
    def __init__(self, db_path):
        if not db_path.exists():
            print(f"No database at {db_path}. Create it with schema.sql first.")
            sys.exit(1)

        try:
            self.conn = sqlite3.connect(db_path)
            self.conn.execute("PRAGMA journal_mode=WAL;")
        except sqlite3.Error as exc:
            print(f"Could not open database at {db_path}: {exc}")
            sys.exit(1)
        self.rows_written = 0

        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=CLIENT_ID,
            clean_session=False,  # persistent session — see docstring
        )
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect

    # ---------------- MQTT callbacks ----------------

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code != 0:
            print(f"Connect failed: {reason_code}")
            return

        # flags.session_present tells us whether the broker still had our
        # session. False means anything published while we were away is gone.
        resumed = "resumed existing session" if flags.session_present else "new session"
        print(f"Connected to {BROKER_HOST} ({resumed})")

        # Subscribe at QoS 1. Must re-subscribe on every connect.
        client.subscribe([
            (READING_TOPIC, 1),
            (STATUS_TOPIC, 1),
            (FORECAST_TOPIC, 1),
            (AQHI_TOPIC, 1),
        ])

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        if reason_code != 0:
            print(f"Unexpected disconnect ({reason_code}) — will retry")

    def _on_message(self, client, userdata, msg):
        # Topic is sensors/<device-id>/<kind>
        parts = msg.topic.split("/")
        if len(parts) != 3:
            print(f"Ignoring unexpected topic: {msg.topic}")
            return

        _, device_id, kind = parts

        if kind == "status":
            state = msg.payload.decode("utf-8", errors="replace")
            print(f"  [status] {device_id} is {state}")
            return

        if kind == "reading":
            self._handle_reading(device_id, msg.payload)
        elif kind == "forecast":
            self._handle_forecast(device_id, msg.payload)
        elif kind == "aqhi":
            self._handle_aqhi(device_id, msg.payload)

    # ---------------- Storage ----------------

    def _parse_payload(self, device_id, raw_payload, kind):
        """Parse raw_payload as JSON and check it's an object. Returns the
        dict, or None (having already logged why) if it isn't usable."""
        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError:
            print(f"  [bad json] {device_id} {kind}: {raw_payload[:80]!r}")
            return None

        if not isinstance(payload, dict):
            print(f"  [bad payload] {device_id} {kind}: expected an object")
            return None

        return payload

    def _insert_rows(self, table, columns, rows):
        """INSERT OR IGNORE rows into table, logging and swallowing any
        sqlite3.Error so one bad batch doesn't take down the callback.
        Returns the number of rows actually inserted, or None on db error."""
        placeholders = ", ".join("?" * len(columns))
        try:
            with self.conn:
                # OR IGNORE: a QoS-1 redelivery of a message we've already
                # stored collides with the table's unique index and is
                # silently dropped instead of duplicating the row.
                cursor = self.conn.executemany(
                    f"""INSERT OR IGNORE INTO {table} ({', '.join(columns)})
                        VALUES ({placeholders})""",
                    rows,
                )
        except sqlite3.Error as exc:
            print(f"  [db error] {exc}")
            return None
        return cursor.rowcount

    def _handle_reading(self, device_id, raw_payload):
        payload = self._parse_payload(device_id, raw_payload, "reading")
        if payload is None:
            return

        # Sensor-side timestamp if present and well-formed, otherwise fall
        # back to now.
        ts = payload.get("ts")
        if ts is not None and not is_valid_recorded_at(ts):
            print(f"  [bad ts] {device_id}: {ts!r} — using receive time instead")
            ts = None
        recorded_at = ts or utc_now_iso()
        received_at = utc_now_iso()

        rows = []
        for key, value in payload.items():
            if key in NON_METRIC_KEYS:
                continue
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                print(f"  [skip] {device_id}.{key} is not numeric: {value!r}")
                continue
            if isinstance(value, float) and not math.isfinite(value):
                print(f"  [skip] {device_id}.{key} is not finite: {value!r}")
                continue
            rows.append((device_id, key, float(value), recorded_at, received_at))

        if not rows:
            return

        inserted = self._insert_rows(
            "readings",
            ("device_id", "metric", "value", "recorded_at", "received_at"),
            rows,
        )
        if inserted is None:
            return

        duplicates = len(rows) - inserted
        if duplicates:
            print(f"  [dedup] {device_id}: skipped {duplicates} duplicate reading(s)")

        self.rows_written += inserted
        metrics = ", ".join(f"{r[1]}={r[2]}" for r in rows)
        print(f"  {device_id}: {metrics}  (total {self.rows_written})")

    def _handle_forecast(self, device_id, raw_payload):
        payload = self._parse_payload(device_id, raw_payload, "forecast")
        if payload is None:
            return

        issued_at = payload.get("issued_at")
        periods = payload.get("periods")
        if not is_valid_recorded_at(issued_at) or not isinstance(periods, list):
            print(f"  [bad forecast] {device_id}: missing/invalid issued_at or periods")
            return

        received_at = utc_now_iso()
        rows = []
        for period in periods:
            name = period.get("name") if isinstance(period, dict) else None
            if not name:
                continue
            rows.append((
                device_id,
                issued_at,
                name,
                period.get("index"),
                period.get("temp_class"),
                period.get("temperature"),
                period.get("pop"),
                period.get("summary"),
                received_at,
            ))

        if not rows:
            return

        inserted = self._insert_rows(
            "forecast_periods",
            ("device_id", "issued_at", "period_name", "period_index",
             "temp_class", "temperature", "pop", "summary", "received_at"),
            rows,
        )
        if inserted is None:
            return

        print(f"  {device_id}: forecast issued {issued_at}, {inserted}/{len(rows)} period(s) stored")

    def _handle_aqhi(self, device_id, raw_payload):
        payload = self._parse_payload(device_id, raw_payload, "aqhi")
        if payload is None:
            return

        received_at = utc_now_iso()
        rows = []

        observation = payload.get("observation")
        if isinstance(observation, dict):
            value = observation.get("value")
            valid_at = observation.get("valid_at")
            if is_valid_recorded_at(valid_at) and isinstance(value, (int, float)) and not isinstance(value, bool):
                rows.append((device_id, "observation", valid_at, "", float(value), received_at))

        forecast = payload.get("forecast")
        if isinstance(forecast, dict):
            issued_at = forecast.get("issued_at")
            if is_valid_recorded_at(issued_at):
                for period in forecast.get("periods", []):
                    name = period.get("name") if isinstance(period, dict) else None
                    value = period.get("value") if isinstance(period, dict) else None
                    if name and isinstance(value, (int, float)) and not isinstance(value, bool):
                        rows.append((device_id, "forecast", issued_at, name, float(value), received_at))

        if not rows:
            return

        inserted = self._insert_rows(
            "aqhi",
            ("device_id", "kind", "valid_at", "period_name", "value", "received_at"),
            rows,
        )
        if inserted is None:
            return

        print(f"  {device_id}: aqhi {inserted}/{len(rows)} row(s) stored")

    # ---------------- Lifecycle ----------------

    def run(self):
        try:
            self.client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
        except OSError as exc:
            print(f"Could not reach broker at {BROKER_HOST}:{BROKER_PORT} — {exc}")
            sys.exit(1)

        print(f"Logging to {DB_PATH}")
        print("Waiting for messages. Ctrl+C to stop.\n")

        try:
            # loop_forever handles reconnection automatically and runs
            # callbacks in this thread, so there's no cross-thread SQLite use.
            self.client.loop_forever()
        except KeyboardInterrupt:
            print("\nStopping...")
        finally:
            self.client.disconnect()
            self.conn.close()
            print(f"Wrote {self.rows_written} rows this session.")


if __name__ == "__main__":
    Logger(DB_PATH).run()

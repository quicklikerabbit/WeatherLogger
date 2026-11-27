#!/usr/bin/env python3
"""
Ecowitt bridge — subscribes to the GW3000B gateway's own MQTT uploads and
republishes them on the project's topic scheme, one device per physical
sensor: `gw3000b` (the gateway's built-in indoor sensors) and `wn31-ch1`
(a WN31 temperature/humidity sensor paired on channel 1).

The gateway (Weather Services -> Customized -> MQTT) publishes to
ecowitt/<MAC> on this same broker, but in Ecowitt's upload format rather
than ours: a URL-encoded form string, not JSON, in imperial units, with
Ecowitt's field names and a handful of firmware diagnostics mixed in:

    PASSKEY=...&stationtype=GW3000B_V1.2.6&dateutc=2026-11-26%2019%3A54%3A50
    &tempinf=70.34&humidityin=51&baromrelin=29.710&baromabsin=29.710&...

This translates that into a normal reading — metric units, our metric
names, `ts` from the gateway's own clock — so logger.py stores it like any
other device's and needs no Ecowitt-specific knowledge.

Every sensor paired with the gateway arrives in the same upload, as more
fields in the same payload (a WN31 on channel N adds tempNf/humidityN).
Since each sensor is a different physical location, the bridge splits the
upload into one reading per device — see DEVICES below. Pairing another
sensor means adding an entry there.

Usage:
    source ~/weather/venv/bin/activate
    python ecowitt_publisher.py

Stop with Ctrl+C.
"""

import json
import os
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs

import paho.mqtt.client as mqtt

# --------------------------------------------------------------------
# Config
# --------------------------------------------------------------------

BROKER_HOST = os.environ.get("BROKER_HOST", "localhost")
BROKER_PORT = 1883

# The gateway's "Publish Topic" setting — its default, built from its MAC.
SOURCE_TOPIC = "ecowitt/5C013B43BDB3"

GATEWAY_ID = "gw3000b"


def reading_topic(device_id):
    return f"sensors/{device_id}/reading"


def status_topic(device_id):
    return f"sensors/{device_id}/status"


# Fixed client ID plus a persistent session, like logger.py's: gateway
# uploads that arrive while the bridge is restarting are queued by the
# broker rather than lost (to the extent the gateway publishes at QoS 1).
# Kept as-is when the bridge grew more devices, since changing it would
# abandon the broker session.
CLIENT_ID = f"bridge-{GATEWAY_ID}"

# The gateway reports its own upload interval in each payload; this is the
# fallback until the first one arrives. A device is declared offline after
# this many intervals pass without its fields appearing in an upload.
DEFAULT_INTERVAL_S = 60
STALE_AFTER_INTERVALS = 3

# How far the gateway's clock may disagree with ours before its timestamp
# is distrusted. Right after boot, before NTP syncs, it can be wildly
# wrong — and a bogus ts is worse than none, since logger.py would file
# the reading at the wrong time and dedup could collide with real ones.
MAX_CLOCK_SKEW = timedelta(minutes=10)

# --------------------------------------------------------------------


def _f_to_c(value):
    return round((value - 32) * 5 / 9, 2)


def _inhg_to_hpa(value):
    return round(value * 33.8639, 2)


def _as_is(value):
    return value


# Device ID -> {Ecowitt field -> (our metric name, unit conversion)}.
# Anything not listed here — PASSKEY, firmware diagnostics, fields from
# sensors we don't map yet — is dropped, so a firmware update that adds a
# field can't create junk metrics in `readings`.
#
# Pressure uses the relative (sea-level) value, the one comparable with
# EC's; it only differs from absolute once an altitude offset is set
# under Calibration in the gateway's web UI.
#
# The WN31's battN is a flag, not a level: 0 = OK, 1 = low. It's stored
# as-is under a name that says which way round it is.
DEVICES = {
    GATEWAY_ID: {
        "tempinf": ("temperature", _f_to_c),
        "humidityin": ("humidity", _as_is),
        "baromrelin": ("pressure", _inhg_to_hpa),
    },
    "wn31-ch1": {
        "temp1f": ("temperature", _f_to_c),
        "humidity1": ("humidity", _as_is),
        "batt1": ("battery_low", _as_is),
    },
}


def _gateway_ts(raw, now):
    """The gateway's `dateutc` ("YYYY-MM-DD HH:MM:SS", UTC, no zone marker)
    in our canonical form, or None if it's missing, unparseable, or too far
    from `now` to trust."""
    if raw is None:
        return None
    try:
        ts = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    if abs(ts - now) > MAX_CLOCK_SKEW:
        return None
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ecowitt(raw_payload, now=None):
    """Translate one Ecowitt upload into {device_id: reading}, where each
    reading is {"ts": ..., metric: value, ...}. A device is left out when
    none of its fields carried a usable number (e.g. a sensor that's lost
    contact with the gateway), so the result may be empty. `ts` is omitted
    when the gateway's clock can't be trusted, leaving logger.py to fall
    back to receive time."""
    if now is None:
        now = datetime.now(timezone.utc)
    if isinstance(raw_payload, bytes):
        raw_payload = raw_payload.decode("utf-8", errors="replace")
    fields = {key: values[0] for key, values in parse_qs(raw_payload).items()}
    ts = _gateway_ts(fields.get("dateutc"), now)

    readings = {}
    for device_id, device_fields in DEVICES.items():
        reading = {}
        for field, (metric, convert) in device_fields.items():
            if field not in fields:
                continue
            try:
                value = float(fields[field])
            except ValueError:
                continue
            reading[metric] = convert(value)
        if reading:
            readings[device_id] = {"ts": ts, **reading} if ts else reading
    return readings


def upload_interval(raw_payload):
    """The gateway's self-reported upload interval in seconds, or None."""
    if isinstance(raw_payload, bytes):
        raw_payload = raw_payload.decode("utf-8", errors="replace")
    values = parse_qs(raw_payload).get("interval")
    try:
        interval = int(values[0]) if values else None
    except ValueError:
        return None
    return interval if interval and interval > 0 else None


# ---------------- MQTT bridging ----------------


class EcowittBridge:
    """Subscribes to the gateway's topic, republishes translated readings
    per device, and tracks whether each device (not just this bridge) is
    alive."""

    def __init__(self):
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=CLIENT_ID,
            clean_session=False,
        )
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        # Covers the bridge dying. MQTT allows one will per connection, so
        # only the gateway gets one; the other devices' retained "online"
        # outlives a crash (though not a clean shutdown — see shutdown()).
        # A device going quiet while the bridge stays up is covered by
        # check_stale() instead.
        self.client.will_set(status_topic(GATEWAY_ID), "offline", qos=1, retain=True)

        # Written from paho's network thread, read from the main loop. The
        # main loop iterates over copies, and a check that sees a value one
        # tick stale is harmless here.
        self.last_seen = {}  # device_id -> time.monotonic() of its last reading
        self.interval_s = DEFAULT_INTERVAL_S
        self.online = set()  # device IDs currently announced as online

    def connect(self):
        self.client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code != 0:
            print(f"[bridge] connect failed: {reason_code}")
            return
        resumed = "resumed existing session" if flags.session_present else "new session"
        print(f"[bridge] connected ({resumed}), listening on {SOURCE_TOPIC}")
        # Must re-subscribe on every connect, as in logger.py. Status isn't
        # published here: "online" means the gateway is uploading, which
        # only the first upload can show.
        client.subscribe(SOURCE_TOPIC, qos=1)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        print(f"[bridge] disconnected ({reason_code})")

    def _on_message(self, client, userdata, msg):
        self.handle_upload(msg.payload)

    def handle_upload(self, raw_payload):
        readings = parse_ecowitt(raw_payload)
        if not readings:
            print(f"  [skip] no usable fields in upload: {raw_payload[:80]!r}")
            return

        if not any("ts" in reading for reading in readings.values()):
            print("  [clock] gateway dateutc missing or skewed — logger will use receive time")

        self.interval_s = upload_interval(raw_payload) or self.interval_s
        now = time.monotonic()
        for device_id, reading in readings.items():
            topic = reading_topic(device_id)
            self.client.publish(topic, json.dumps(reading), qos=1, retain=False)
            print(f"  {topic}  {json.dumps(reading)}")
            self.last_seen[device_id] = now
            if device_id not in self.online:
                self._set_status(device_id, "online")

    def check_stale(self):
        """Mark each device offline once STALE_AFTER_INTERVALS uploads in a
        row have passed without a reading from it — whether because the
        gateway stopped uploading or just that sensor dropped out."""
        now = time.monotonic()
        for device_id in list(self.online):
            silent_s = now - self.last_seen[device_id]
            if silent_s > self.interval_s * STALE_AFTER_INTERVALS:
                print(f"[{device_id}] no reading for {int(silent_s)}s — marking offline")
                self._set_status(device_id, "offline")

    def _set_status(self, device_id, state):
        self.client.publish(status_topic(device_id), state, qos=1, retain=True)
        if state == "online":
            self.online.add(device_id)
        else:
            self.online.discard(device_id)

    def shutdown(self):
        # The gateway always, since its will is replaced by this; the
        # others only if they're currently online.
        for device_id in {GATEWAY_ID, *self.online}:
            self._set_status(device_id, "offline")
        time.sleep(0.2)  # let the publish flush
        self.client.loop_stop()
        self.client.disconnect()


def main():
    bridge = EcowittBridge()
    try:
        bridge.connect()
    except OSError as exc:
        print(f"Could not reach broker at {BROKER_HOST}:{BROKER_PORT} — {exc}")
        sys.exit(1)

    running = {"flag": True}

    def handle_signal(signum, frame):
        running["flag"] = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    targets = ", ".join(f"sensors/{device_id}/*" for device_id in DEVICES)
    print(f"Bridging {SOURCE_TOPIC} -> {targets}. Ctrl+C to stop.\n")

    # Messages are handled on paho's thread; this loop only watches for the
    # gateway going quiet. Short sleeps so Ctrl+C responds promptly.
    while running["flag"]:
        bridge.check_stale()
        for _ in range(50):
            if not running["flag"]:
                break
            time.sleep(0.1)

    print("\nShutting down...")
    bridge.shutdown()
    print("Done.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Fake sensor publisher — stands in for real hardware while the data
spine is being built.

Simulates several devices, each with its own MQTT connection, its own
Last Will and Testament, and plausible drifting values.

Usage:
    source ~/weather/venv/bin/activate
    python fake_publisher.py

Stop with Ctrl+C.
"""

import json
import math
import os
import random
import signal
import sys
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

# --------------------------------------------------------------------
# Config
# --------------------------------------------------------------------

# Defaults to localhost (for running on the Pi itself); override with
# BROKER_HOST=<pi-ip> when publishing from another device on the network.
BROKER_HOST = os.environ.get("BROKER_HOST", "localhost")
BROKER_PORT = 1883
PUBLISH_INTERVAL = 10  # seconds between readings

# Each device: starting values and how far each metric can drift per tick.
# 'diurnal' metrics get a slow sine wave layered on so the data looks
# like a day rather than pure noise.
DEVICES = {
    "fake-gw3002": {
        "temperature": {"start": 14.0, "drift": 0.15, "diurnal": 6.0, "min": -10, "max": 40},
        "humidity":    {"start": 72.0, "drift": 0.8,  "diurnal": -15.0, "min": 20, "max": 100},
        "pressure":    {"start": 1013.0, "drift": 0.2, "min": 970, "max": 1050},
        "wind_speed":  {"start": 8.0,  "drift": 1.5,  "min": 0,  "max": 80},
    },
    "fake-wn31-a": {
        "temperature": {"start": 21.0, "drift": 0.1, "diurnal": 1.5, "min": 5, "max": 35},
        "humidity":    {"start": 45.0, "drift": 0.5, "min": 20, "max": 90},
    },
    "fake-pm-sensor": {
        "pm25": {"start": 6.0,  "drift": 1.2, "min": 0, "max": 500},
        "pm10": {"start": 11.0, "drift": 2.0, "min": 0, "max": 600},
    },
}

TOPIC_READING = "sensors/{device_id}/reading"
TOPIC_STATUS = "sensors/{device_id}/status"

# --------------------------------------------------------------------


def utc_now_iso():
    """Timestamp in ISO 8601 with a Z suffix. Generated here, at the
    'sensor', not at the logger — so a queued message stays accurate."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeDevice:
    """One simulated sensor, with its own broker connection."""

    def __init__(self, device_id, metrics):
        self.device_id = device_id
        self.metrics = metrics
        self.values = {name: spec["start"] for name, spec in metrics.items()}

        self.status_topic = TOPIC_STATUS.format(device_id=device_id)
        self.reading_topic = TOPIC_READING.format(device_id=device_id)

        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"pub-{device_id}",
        )
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

        # Last Will and Testament: the broker publishes this on our behalf
        # if we drop without disconnecting cleanly. Retained, so anyone
        # subscribing later immediately learns this device is offline.
        self.client.will_set(self.status_topic, "offline", qos=1, retain=True)

    def connect(self):
        self.client.connect(BROKER_HOST, BROKER_PORT, keepalive=30)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            print(f"[{self.device_id}] connected")
            client.publish(self.status_topic, "online", qos=1, retain=True)
        else:
            print(f"[{self.device_id}] connect failed: {reason_code}")

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        print(f"[{self.device_id}] disconnected ({reason_code})")

    def _next_value(self, name, spec, tick):
        """Random walk, optionally with a daily cycle layered on top."""
        value = self.values[name]
        value += random.uniform(-spec["drift"], spec["drift"])

        if "diurnal" in spec:
            # One full cycle per simulated 'day' of 8640 ticks at 10s.
            # Shortened here so you see a cycle in minutes, not hours.
            phase = math.sin(tick / 90.0 * 2 * math.pi)
            value += phase * spec["diurnal"] * 0.02

        value = max(spec["min"], min(spec["max"], value))
        self.values[name] = value
        return round(value, 2)

    def publish_reading(self, tick):
        payload = {"ts": utc_now_iso()}
        for name, spec in self.metrics.items():
            payload[name] = self._next_value(name, spec, tick)

        self.client.publish(
            self.reading_topic,
            json.dumps(payload),
            qos=1,
            retain=False,  # time series: never retain
        )
        return payload

    def shutdown(self):
        """Clean exit: say offline deliberately rather than relying on
        the will, then disconnect."""
        self.client.publish(self.status_topic, "offline", qos=1, retain=True)
        time.sleep(0.2)  # let the publish flush
        self.client.loop_stop()
        self.client.disconnect()


def main():
    devices = [FakeDevice(did, metrics) for did, metrics in DEVICES.items()]

    connected = []
    for device in devices:
        try:
            device.connect()
        except OSError as exc:
            print(f"Could not reach broker at {BROKER_HOST}:{BROKER_PORT} — {exc}")
            for started in connected:
                started.shutdown()
            sys.exit(1)
        connected.append(device)

    running = {"flag": True}

    def handle_signal(signum, frame):
        running["flag"] = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    print(f"\nPublishing every {PUBLISH_INTERVAL}s. Ctrl+C to stop.\n")

    tick = 0
    while running["flag"]:
        for device in devices:
            payload = device.publish_reading(tick)
            print(f"  {device.reading_topic}  {json.dumps(payload)}")
        print("")
        tick += 1

        # Sleep in short slices so Ctrl+C responds promptly.
        for _ in range(PUBLISH_INTERVAL * 10):
            if not running["flag"]:
                break
            time.sleep(0.1)

    print("\nShutting down...")
    for device in devices:
        device.shutdown()
    print("Done.")


if __name__ == "__main__":
    main()

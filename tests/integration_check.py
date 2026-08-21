#!/usr/bin/env python3
"""
Integration check — spins up a real mosquitto broker, runs the actual
fake_publisher and logger code against it over real MQTT, and checks
that readings land in a scratch database.

Not part of `python -m unittest discover -s tests`: unlike everything
else under tests/, this needs a mosquitto binary and opens real
sockets. Run it by hand for end-to-end confidence, e.g. after touching
anything MQTT-related:

    python tests/integration_check.py

Exits 0 and prints PASS on success, exits 1 and explains what didn't
match otherwise.
"""

import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import helpers  # adds the repo root to sys.path

import fake_publisher
import logger as logger_module

MOSQUITTO_CANDIDATES = [
    "mosquitto",
    "/opt/homebrew/opt/mosquitto/sbin/mosquitto",
    "/opt/homebrew/sbin/mosquitto",
    "/usr/local/sbin/mosquitto",
    "/usr/sbin/mosquitto",
]

TICKS = 5
# utc_now_iso() has one-second resolution, and recorded_at is part of the
# dedup key — ticks closer together than 1s would collide and some
# readings would be (correctly) dropped as duplicates, making row counts
# unpredictable. Real fake_publisher.py uses a 10s interval; this is
# sped up but kept safely above 1s.
TICK_INTERVAL = 1.1
SETTLE_TIME = 1.0  # let the last few messages flush through the broker


def find_mosquitto():
    for candidate in MOSQUITTO_CANDIDATES:
        path = shutil.which(candidate) or (candidate if Path(candidate).exists() else None)
        if path:
            return path
    return None


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_port(host, port, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def start_broker(mosquitto_bin, work_dir, port):
    config_path = work_dir / "mosquitto.conf"
    config_path.write_text(
        f"listener {port} 127.0.0.1\n"
        "allow_anonymous true\n"
        "persistence false\n"
    )
    log_path = work_dir / "mosquitto.log"
    log_file = open(log_path, "w")
    proc = subprocess.Popen(
        [mosquitto_bin, "-c", str(config_path)],
        stdout=log_file, stderr=subprocess.STDOUT,
    )
    if not wait_for_port("127.0.0.1", port):
        proc.terminate()
        proc.wait()
        log_file.close()
        print(f"mosquitto never opened port {port}. Log:\n{log_path.read_text()}")
        sys.exit(1)
    return proc, log_file


def check_readings(devices, db_conn):
    """Compare the readings table against what the devices should have
    published. Returns a list of problem descriptions (empty = pass)."""
    expected = {
        (device.device_id, metric): TICKS
        for device in devices
        for metric in device.metrics
    }
    rows = db_conn.execute(
        "SELECT device_id, metric, COUNT(*) FROM readings GROUP BY device_id, metric"
    ).fetchall()
    actual = {(device_id, metric): count for device_id, metric, count in rows}

    problems = []
    for key, expected_count in expected.items():
        actual_count = actual.get(key, 0)
        if actual_count != expected_count:
            problems.append(f"{key[0]}.{key[1]}: expected {expected_count} rows, got {actual_count}")
    for key in set(actual) - set(expected):
        problems.append(f"{key[0]}.{key[1]}: unexpected rows ({actual[key]}) — not a known device/metric")

    return problems, sum(actual.values())


def run_logger(tmp, devices, ready, state):
    """Body of the logger's dedicated thread. The sqlite connection and
    all of paho's callbacks (via loop_forever) have to live on the same
    thread — sqlite3 connections can't cross threads — so this mirrors
    logger.py's own Logger.run(), just with loop_forever() stopped by a
    disconnect() call from main() instead of Ctrl+C."""
    test_logger = helpers.make_logger(logger_module.Logger, tmp)
    state["client"] = test_logger.client
    test_logger.client.connect(logger_module.BROKER_HOST, logger_module.BROKER_PORT, keepalive=30)
    ready.set()
    test_logger.client.loop_forever()
    state["problems"], state["total_rows"] = check_readings(devices, test_logger.conn)
    test_logger.conn.close()


def main():
    mosquitto_bin = find_mosquitto()
    if not mosquitto_bin:
        print(
            "No mosquitto binary found. Install it (e.g. `brew install "
            "mosquitto` on macOS, `apt install mosquitto` on Linux) and "
            "try again."
        )
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        port = free_port()
        broker_proc, broker_log = start_broker(mosquitto_bin, tmp_path, port)
        print(f"[mosquitto] running on 127.0.0.1:{port}")

        # Point the real modules at our scratch broker instead of the
        # defaults (localhost:1883) — both read these as globals at
        # connect time, so patching the module attributes is enough.
        fake_publisher.BROKER_HOST = "127.0.0.1"
        fake_publisher.BROKER_PORT = port
        logger_module.BROKER_HOST = "127.0.0.1"
        logger_module.BROKER_PORT = port

        devices = [
            fake_publisher.FakeDevice(device_id, metrics)
            for device_id, metrics in fake_publisher.DEVICES.items()
        ]

        ready = threading.Event()
        state = {}
        logger_thread = threading.Thread(
            target=run_logger, args=(tmp, devices, ready, state), daemon=True
        )

        try:
            # Logger first, then publishers — matches the real deploy
            # order (weather-ec-publisher orders itself after
            # weather-logger in systemd/).
            logger_thread.start()
            if not ready.wait(timeout=5):
                print("logger never connected to the broker")
                sys.exit(1)

            for device in devices:
                device.connect()
            time.sleep(0.5)  # let connects and subscribes settle

            print(f"[fake_publisher] {len(devices)} device(s) connected, publishing {TICKS} tick(s)...")
            for tick in range(TICKS):
                for device in devices:
                    device.publish_reading(tick)
                time.sleep(TICK_INTERVAL)

            time.sleep(SETTLE_TIME)

            for device in devices:
                device.shutdown()
            time.sleep(SETTLE_TIME)
        finally:
            if "client" in state:
                state["client"].disconnect()
            logger_thread.join(timeout=5)
            broker_proc.terminate()
            try:
                broker_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                broker_proc.kill()
                broker_proc.wait()
            broker_log.close()

        if "problems" not in state:
            print("logger thread didn't finish cleanly — no results to check")
            sys.exit(1)

        problems, total_rows = state["problems"], state["total_rows"]
        if problems:
            print("FAIL")
            for problem in problems:
                print(f"  {problem}")
            sys.exit(1)

        print(f"PASS — {len(devices)} device(s), {total_rows} reading rows, all as expected.")


if __name__ == "__main__":
    main()

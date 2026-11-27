#!/usr/bin/env python3
"""
One-off Environment Canada backfill — republishes the citypage bulletins
and AQHI files Datamart still holds for a past UTC window, over MQTT as
device ec-victoria, the same as ec_publisher.py's live poll would have.

For filling an outage on the Pi (it was down, so the live poll never ran).
Precipitation isn't covered here: ec_publisher.py's 48-hour climate-hourly
lookback refills recent hours by itself, and backfill_precip.py covers
anything older.

Like backfill_precip.py, this goes through MQTT rather than writing to
sensors.db directly, so logger.py stays the only thing that writes the
database. Its unique indexes make re-running this, or overlapping the
live publisher, a harmless no-op for anything already stored.

What Datamart keeps, and so how far back this can reach:
  - Citypage bulletins sit in today/citypage_weather/BC/{HH}/, one
    directory per UTC hour, overwritten 24 hours later. Anything older
    than that is gone. Each bulletin's filename is checked against the
    requested date, so a stale request finds nothing rather than picking
    up today's bulletin for the same hour.
  - AQHI files are in date-partitioned directories, which last longer.

Every bulletin and AQHI file in the window is published, not just the
latest per hour, in chronological order.

Usage:
    BROKER_HOST=<pi-ip> python backfill_ec.py --start 2026-11-26T09:00 --end 2026-11-26T19:00 --dry-run
    BROKER_HOST=<pi-ip> python backfill_ec.py --start 2026-11-26T09:00 --end 2026-11-26T19:00

Times are UTC; --end is exclusive and defaults to now.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone

import paho.mqtt.client as mqtt

from ec_publisher import (
    AQHI_LOCATION,
    AQHI_REGION,
    BROKER_HOST,
    BROKER_PORT,
    CITYPAGE_PROVINCE,
    CITYPAGE_SITE,
    DATAMART,
    DEVICE_ID,
    TOPIC_AQHI,
    TOPIC_FORECAST,
    TOPIC_READING,
    http_get,
    list_directory,
    parse_aqhi_forecast,
    parse_aqhi_observation,
    parse_citypage,
)

# Both citypage ("20261126T100401.021Z_...") and AQHI ("20261126T1000Z_...")
# filenames start with the UTC hour they were issued in, in this form.
HOUR_PREFIX = "%Y%m%dT%H"


def _hours(start, end):
    """Every UTC hour start <= h < end, truncated to the hour."""
    hour = start.replace(minute=0, second=0, microsecond=0)
    while hour < end:
        yield hour
        hour += timedelta(hours=1)


def fetch_citypage_bulletins(start, end):
    """[(filename, xml_bytes)] for every Victoria bulletin issued in
    [start, end) that Datamart still has, chronologically."""
    bulletins = []
    for hour in _hours(start, end):
        dir_url = f"{DATAMART}/today/citypage_weather/{CITYPAGE_PROVINCE}/{hour:%H}/"
        prefix = hour.strftime(HOUR_PREFIX)
        names = sorted(
            f for f in list_directory(dir_url)
            if f.endswith(f"{CITYPAGE_SITE}_en.xml") and f.startswith(prefix)
        )
        bulletins.extend((name, http_get(dir_url + name)) for name in names)
    return bulletins


def fetch_aqhi_files(kind, start, end):
    """[(filename, parsed_json)] for every AQHI `kind` ('observation' or
    'forecast') file issued in [start, end), chronologically."""
    prefixes = {hour.strftime(HOUR_PREFIX) for hour in _hours(start, end)}
    dates = sorted({prefix[:8] for prefix in prefixes})
    files = []
    for date_str in dates:
        dir_url = f"{DATAMART}/{date_str}/WXO-DD/air_quality/aqhi/{AQHI_REGION}/{kind}/realtime/json/"
        names = sorted(
            f for f in list_directory(dir_url)
            if f.endswith(f"{AQHI_LOCATION}.json") and f[:len(HOUR_PREFIX) + 2] in prefixes
        )
        files.extend((name, json.loads(http_get(dir_url + name))) for name in names)
    return files


def build_messages(bulletins, aqhi_observations, aqhi_forecasts):
    """Everything fetched -> [(topic, payload)], in the same shapes
    ec_publisher.py's poll_once publishes. Unparseable files are skipped
    (with a note), not fatal."""
    messages = []
    for name, xml_bytes in bulletins:
        try:
            reading, forecast = parse_citypage(xml_bytes)
        except Exception as exc:
            print(f"  [skip] {name}: {exc}")
            continue
        if reading:
            messages.append((TOPIC_READING, reading))
        if forecast:
            messages.append((TOPIC_FORECAST, forecast))

    for name, data in aqhi_observations:
        observation = parse_aqhi_observation(data)
        if observation:
            messages.append((TOPIC_AQHI, {"observation": observation}))
        else:
            print(f"  [skip] {name}: no usable observation")

    for name, data in aqhi_forecasts:
        forecast = parse_aqhi_forecast(data)
        if forecast:
            messages.append((TOPIC_AQHI, {"forecast": forecast}))
        else:
            print(f"  [skip] {name}: no usable forecast")

    return messages


def summarize(messages):
    readings = [p for t, p in messages if t == TOPIC_READING]
    forecasts = [p for t, p in messages if t == TOPIC_FORECAST]
    observations = [p["observation"] for t, p in messages if t == TOPIC_AQHI and "observation" in p]
    aqhi_forecasts = [p["forecast"] for t, p in messages if t == TOPIC_AQHI and "forecast" in p]

    def span(values, key):
        stamps = sorted({v[key] for v in values})
        return f" ({stamps[0]} .. {stamps[-1]}, {len(stamps)} distinct)" if stamps else ""

    print(f"{len(readings)} current-conditions reading(s){span(readings, 'ts')}")
    print(f"{len(forecasts)} citypage forecast(s){span(forecasts, 'issued_at')}")
    print(f"{len(observations)} AQHI observation(s){span(observations, 'valid_at')}")
    print(f"{len(aqhi_forecasts)} AQHI forecast(s){span(aqhi_forecasts, 'issued_at')}")


def publish(messages, rate):
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        # Distinct from ec_publisher.py's "pub-ec-victoria" (and
        # backfill_precip.py's) — reusing it would make the broker kick
        # the live publisher off mid-run.
        client_id=f"backfill-ec-{DEVICE_ID}",
    )
    client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
    client.loop_start()
    try:
        unacked = 0
        for topic, payload in messages:
            info = client.publish(topic, json.dumps(payload), qos=1, retain=False)
            info.wait_for_publish(timeout=30)
            if not info.is_published():
                unacked += 1
            # Throttled for the same reason as backfill_precip.py: logger.py
            # commits per message, and mosquitto drops what queues past its
            # limit for a slow subscriber.
            time.sleep(1 / rate)
    finally:
        client.loop_stop()
        client.disconnect()

    print(f"Published {len(messages) - unacked}/{len(messages)} message(s) to {BROKER_HOST}")
    return unacked


def _parse_utc(value):
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise argparse.ArgumentTypeError(f"expected YYYY-MM-DDTHH:MM (UTC), got {value!r}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--start", required=True, type=_parse_utc, help="UTC, YYYY-MM-DDTHH:MM")
    parser.add_argument("--end", type=_parse_utc, help="UTC, YYYY-MM-DDTHH:MM (exclusive; default now)")
    parser.add_argument("--rate", type=float, default=1.0, help="messages/second (default 1)")
    parser.add_argument("--dry-run", action="store_true", help="fetch and summarize, don't publish")
    args = parser.parse_args()

    end = args.end or datetime.now(timezone.utc)
    if end - args.start > timedelta(hours=24):
        print("Note: citypage bulletins older than 24 hours have expired from Datamart; "
              "only AQHI can be recovered for that part of the window.")

    messages = build_messages(
        fetch_citypage_bulletins(args.start, end),
        fetch_aqhi_files("observation", args.start, end),
        fetch_aqhi_files("forecast", args.start, end),
    )
    summarize(messages)

    if args.dry_run or not messages:
        return
    try:
        unacked = publish(messages, args.rate)
    except OSError as exc:
        print(f"Could not reach broker at {BROKER_HOST}:{BROKER_PORT} — {exc}")
        sys.exit(1)
    if unacked:
        sys.exit(1)


if __name__ == "__main__":
    main()

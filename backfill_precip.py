#!/usr/bin/env python3
"""
One-off precipitation backfill — republishes every climate-hourly hour for
a date range over MQTT, as device ec-victoria, exactly as ec_publisher.py's
live poll would have.

Before the 48-hour lookback in ec_publisher.py, each poll fetched only the
archive's single newest hour. The archive releases hours in roughly daily
batches, so that captured about one hour per day and silently dropped the
rest. This fills those gaps. Goes through MQTT (rather than writing to
sensors.db directly) so logger.py stays the only thing that writes the
database, and its (device_id, metric, recorded_at) unique index makes
re-running this — or overlapping the live publisher — a harmless no-op
for hours already stored.

Usage:
    BROKER_HOST=<pi-host> python backfill_precip.py --start 2026-08-20 --dry-run
    BROKER_HOST=<pi-host> python backfill_precip.py --start 2026-08-20

--end defaults to now. Dates are UTC.

--rate throttles publishing (messages/second, default 1). logger.py commits
each message individually, which on the Pi's SD card manages only a few
per second, and mosquitto's default max_queued_messages (1000) silently
drops anything queued past that for a slow subscriber. An unthrottled run
of 1567 hours lost 426 of them that way.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone

import paho.mqtt.client as mqtt

from ec_publisher import (
    BROKER_HOST,
    BROKER_PORT,
    CLIMATE_IDENTIFIER,
    DEVICE_ID,
    GEOMET,
    TOPIC_READING,
    http_get,
    parse_climate_hour,
    precip_reading_payload,
)

PAGE_SIZE = 500


def _utc_iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_climate_range(start, end):
    """Every parseable climate-hourly hour with start <= UTC_DATE < end, in
    chronological order. The API's datetime= filter matches on the
    station's LOCAL_DATE (local standard time), not UTC, so the request
    window is padded by a day each side and trimmed on UTC_DATE here."""
    window = f"{_utc_iso(start - timedelta(days=1))}/{_utc_iso(end + timedelta(days=1))}"
    start_s, end_s = _utc_iso(start), _utc_iso(end)

    hours = {}
    offset = 0
    while True:
        url = (f"{GEOMET}/collections/climate-hourly/items"
               f"?CLIMATE_IDENTIFIER={CLIMATE_IDENTIFIER}&datetime={window}"
               f"&sortby=UTC_DATE&limit={PAGE_SIZE}&offset={offset}&f=json")
        features = json.loads(http_get(url)).get("features") or []
        for feature in features:
            hour = parse_climate_hour(feature)
            if hour and start_s <= hour["ts"] < end_s:
                hours[hour["ts"]] = hour
        if len(features) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    return [hours[ts] for ts in sorted(hours)]


def summarize(hours, start, end):
    expected = int((end - start).total_seconds() // 3600)
    flags = {}
    for h in hours:
        if "quality_flag" in h:
            flags[h["quality_flag"]] = flags.get(h["quality_flag"], 0) + 1
    total_mm = sum(h["precipitation_mm"] for h in hours)
    print(f"{len(hours)} hour(s) from the archive (of ~{expected} in range), "
          f"total {total_mm:.1f} mm, flags {flags or 'none'}")
    if hours:
        print(f"  first {hours[0]['ts']}, last {hours[-1]['ts']}")


def publish(hours, rate):
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        # Distinct from ec_publisher.py's "pub-ec-victoria" — reusing it
        # would make the broker kick the live publisher off mid-run.
        client_id=f"backfill-{DEVICE_ID}",
    )
    client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
    client.loop_start()
    try:
        unacked = 0
        for i, h in enumerate(hours, 1):
            info = client.publish(TOPIC_READING, json.dumps(precip_reading_payload(h)), qos=1, retain=False)
            info.wait_for_publish(timeout=30)
            if not info.is_published():
                unacked += 1
            if i % 100 == 0:
                print(f"  {i}/{len(hours)} published (through {h['ts']})")
            time.sleep(1 / rate)
    finally:
        client.loop_stop()
        client.disconnect()

    print(f"Published {len(hours) - unacked}/{len(hours)} reading(s) to {BROKER_HOST}")
    return unacked


def _parse_date(value):
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--start", required=True, type=_parse_date, help="UTC date, YYYY-MM-DD")
    parser.add_argument("--end", type=_parse_date, help="UTC date, YYYY-MM-DD (exclusive; default now)")
    parser.add_argument("--rate", type=float, default=1.0, help="messages/second (default 1)")
    parser.add_argument("--dry-run", action="store_true", help="fetch and summarize, don't publish")
    args = parser.parse_args()

    end = args.end or datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    hours = fetch_climate_range(args.start, end)
    summarize(hours, args.start, end)

    if args.dry_run or not hours:
        return
    try:
        unacked = publish(hours, args.rate)
    except OSError as exc:
        print(f"Could not reach broker at {BROKER_HOST}:{BROKER_PORT} — {exc}")
        sys.exit(1)
    if unacked:
        sys.exit(1)


if __name__ == "__main__":
    main()

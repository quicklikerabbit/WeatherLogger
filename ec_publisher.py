#!/usr/bin/env python3
"""
Environment Canada publisher — polls MSC Datamart for Victoria's current
conditions, forecast, and Air Quality Health Index, and republishes them
over MQTT on the same topic scheme as the other publishers.

Real, messy, externally-sourced data instead of the fake publisher's tidy
sine waves — and it starts building Victoria baseline history now, before
real hardware exists to compare it against.

Sources (see https://dd.weather.gc.ca):
  - Citypage XML for current conditions + multi-day forecast:
    today/citypage_weather/{PROV}/{HH}/. Site codes come from
    today/citypage_weather/siteList.xml — Victoria is s0000775.
  - AQHI observation/forecast JSON, date-partitioned rather than under
    today/: {YYYYMMDD}/WXO-DD/air_quality/aqhi/{region}/{observation,forecast}/realtime/json/.
    Victoria falls under region "pyr" (Pacific and Yukon), station code
    JBOBQ ("Victoria / Saanich") — found by listing the region directory,
    since there's no sitewide index like citypage's.

Usage:
    source ~/weather/venv/bin/activate
    python ec_publisher.py

Stop with Ctrl+C.
"""

import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import paho.mqtt.client as mqtt

# --------------------------------------------------------------------
# Config
# --------------------------------------------------------------------

BROKER_HOST = os.environ.get("BROKER_HOST", "localhost")
BROKER_PORT = 1883

DEVICE_ID = "ec-victoria"
TOPIC_READING = f"sensors/{DEVICE_ID}/reading"
TOPIC_FORECAST = f"sensors/{DEVICE_ID}/forecast"
TOPIC_AQHI = f"sensors/{DEVICE_ID}/aqhi"
TOPIC_STATUS = f"sensors/{DEVICE_ID}/status"

# MSC observations only update hourly, and Datamart has a usage policy
# against hammering the servers — hourly is both sufficient and the limit.
POLL_INTERVAL = 3600
# Wait this long after the top of the UTC hour before fetching, so the
# bulletin has actually landed (citypage files showed up ~1 min after
# the hour in testing; 5 min leaves plenty of margin).
POLL_DELAY = 300

DATAMART = "https://dd.weather.gc.ca"
CITYPAGE_PROVINCE = "BC"
CITYPAGE_SITE = "s0000775"    # Victoria
AQHI_REGION = "pyr"           # Pacific and Yukon Region
AQHI_LOCATION = "JBOBQ"       # Victoria / Saanich
SWOB_STATION = "CYYJ-MAN"     # Victoria Int'l Airport, manned/augmented obs

USER_AGENT = "WeatherLogger/1.0 (personal weather station project)"
HREF_RE = re.compile(r'href="([^"?][^"]*)"')

# --------------------------------------------------------------------


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def _best_effort(label, fn):
    """Runs fn() and returns its result, or None if it raises. Used for a
    poll section that's allowed to be missing (network hiccup, absent
    bulletin) without sinking the sections that already succeeded."""
    try:
        return fn()
    except Exception as exc:
        print(f"  [skip] {label}: {exc}")
        return None


def list_directory(url):
    """Datamart directories are plain Apache autoindex HTML. Pull
    filenames out of the href attributes rather than pull in an HTML
    parser dependency for one regex's worth of work."""
    try:
        html = http_get(url).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return []
        raise
    return HREF_RE.findall(html)


# ---------------- Citypage XML (current conditions + forecast) ----------------


def fetch_citypage_xml():
    """Step back through recent UTC hour directories until Victoria's
    bulletin turns up — normally the current hour, but a step back covers
    a slow-to-publish bulletin without the poll failing outright."""
    now = datetime.now(timezone.utc)
    for hours_back in range(4):
        hour_dt = now - timedelta(hours=hours_back)
        hh = hour_dt.strftime("%H")
        dir_url = f"{DATAMART}/today/citypage_weather/{CITYPAGE_PROVINCE}/{hh}/"
        files = [f for f in list_directory(dir_url) if f.endswith(f"{CITYPAGE_SITE}_en.xml")]
        if files:
            return http_get(dir_url + sorted(files)[-1])
    raise RuntimeError(f"No citypage bulletin found for site {CITYPAGE_SITE} in the last few hours")


def _utc_timestamp(elem):
    ts_el = elem.find("dateTime[@zone='UTC']/timeStamp")
    if ts_el is None or not ts_el.text:
        return None
    dt = datetime.strptime(ts_el.text, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _numeric(elem, path):
    target = elem.find(path)
    if target is None or not target.text:
        return None
    text = target.text.strip()
    try:
        return float(text)
    except ValueError:
        return 0.0 if text.lower() == "calm" else None


def parse_citypage(xml_bytes):
    """Returns (reading, forecast), either of which may be None if that
    section was missing or unparseable — a bad forecast block shouldn't
    stop the current conditions from being published."""
    root = ET.fromstring(xml_bytes)

    reading = None
    cc = root.find("currentConditions")
    if cc is not None:
        recorded_at = _utc_timestamp(cc)
        metrics = {
            "temperature": _numeric(cc, "temperature"),
            "dewpoint": _numeric(cc, "dewpoint"),
            "humidity": _numeric(cc, "relativeHumidity"),
            "pressure": _numeric(cc, "pressure"),
            "visibility": _numeric(cc, "visibility"),
            "wind_speed": _numeric(cc, "wind/speed"),
            "wind_gust": _numeric(cc, "wind/gust"),
            "wind_bearing": _numeric(cc, "wind/bearing"),
        }
        if metrics["pressure"] is not None:
            metrics["pressure"] *= 10  # kPa -> hPa, matches the other publishers' units
        metrics = {k: v for k, v in metrics.items() if v is not None}
        if recorded_at and metrics:
            reading = {"ts": recorded_at, **metrics}

    forecast = None
    fg = root.find("forecastGroup")
    if fg is not None:
        issued_at = _utc_timestamp(fg)
        periods = []
        for index, fc in enumerate(fg.findall("forecast")):
            period_el = fc.find("period")
            temp_el = fc.find("temperatures/temperature")
            pop_el = fc.find("abbreviatedForecast/pop")
            summary_el = fc.find("textSummary")
            precip_type_els = fc.findall("precipitation/precipType")

            pop = None
            if pop_el is not None and pop_el.text:
                try:
                    pop = float(pop_el.text)
                except ValueError:
                    pop = None

            temperature = None
            if temp_el is not None and temp_el.text:
                try:
                    temperature = float(temp_el.text)
                except ValueError:
                    temperature = None

            name = period_el.get("textForecastName") if period_el is not None else None
            if not name:
                continue

            periods.append({
                "index": index,
                "name": name,
                "temp_class": temp_el.get("class") if temp_el is not None else None,
                "temperature": temperature,
                "pop": pop,
                # A period can list more than one precipType (e.g. rain
                # changing to snow); join them rather than keep only the
                # first and silently drop the rest.
                "precip_type": ",".join(el.text for el in precip_type_els if el.text) or None,
                "summary": summary_el.text if summary_el is not None else None,
            })
        if issued_at and periods:
            forecast = {"issued_at": issued_at, "periods": periods}

    return reading, forecast


def _normalize_iso(value):
    """Parse an ISO-8601 timestamp (with optional offset/fractional seconds)
    and return it in the strict %Y-%m-%dT%H:%M:%SZ form logger.py requires,
    or None if it's missing or unparseable."""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _seconds_between(ts_a, ts_b):
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    dt_a = datetime.strptime(ts_a, fmt).replace(tzinfo=timezone.utc)
    dt_b = datetime.strptime(ts_b, fmt).replace(tzinfo=timezone.utc)
    return abs((dt_a - dt_b).total_seconds())


# ---------------- AQHI (observation + period forecast) ----------------


def _fetch_latest_aqhi(kind):
    """kind is 'observation' or 'forecast'. Tries today's date-partitioned
    directory, then yesterday's, so a poll shortly after UTC midnight
    doesn't fail before the day's directory exists."""
    now = datetime.now(timezone.utc)
    for days_back in range(2):
        date_str = (now - timedelta(days=days_back)).strftime("%Y%m%d")
        dir_url = f"{DATAMART}/{date_str}/WXO-DD/air_quality/aqhi/{AQHI_REGION}/{kind}/realtime/json/"
        files = [f for f in list_directory(dir_url) if f.endswith(f"{AQHI_LOCATION}.json")]
        if files:
            return json.loads(http_get(dir_url + sorted(files)[-1]))
    return None


def fetch_aqhi():
    """Returns (observation, forecast), either of which may be None."""
    observation = None
    obs_data = _fetch_latest_aqhi("observation")
    if obs_data:
        props = obs_data.get("properties", {})
        valid_at = _normalize_iso(props.get("observation_datetime"))
        if props.get("aqhi") is not None and valid_at:
            observation = {
                "valid_at": valid_at,
                "value": props["aqhi"],
            }

    forecast = None
    fcst_data = _fetch_latest_aqhi("forecast")
    if fcst_data:
        for feature in fcst_data.get("features", []):
            props = feature.get("properties", {})
            if props.get("aqhi_type") != "AQHI-Forecast-Period":
                continue
            issued_at = _normalize_iso(props.get("publication_datetime"))
            periods = [
                {"name": period.get("forecast_period_en"), "value": period.get("aqhi")}
                for period in props.get("forecast_period", {}).values()
                if period.get("forecast_period_en") and period.get("aqhi") is not None
            ]
            if issued_at and periods:
                forecast = {"issued_at": issued_at, "periods": periods}
            break

    return observation, forecast


# ---------------- SWOB-ML (precipitation observation) ----------------

# citypage's currentConditions has no precipitation field at all — this is
# the only Datamart product that reports a measured amount for Victoria.
# The "latest" symlink-style directory always holds the current file, so
# unlike citypage/AQHI there's no hour/date directory to search.
SWOB_NS = {
    "om": "http://www.opengis.net/om/1.0",
    "gml": "http://www.opengis.net/gml",
    "p": "http://dms.ec.gc.ca/schema/point-observation/2.0",
}

# present_weather code -> precip_type, from the SWOB-ML User Guide's
# std_code_src/present_weather table (manned-station codes 0-184; codes not
# listed here — sky/visibility conditions, dust, fog, "recent" weather that
# isn't falling right now, reserved values — aren't precipitation and map to
# no precip_type). Some source codes bundle two phenomena (e.g. "drizzle or
# snow grains"); the bundled ones are filed under the first-listed category.
PRESENT_WEATHER_PRECIP_TYPE = {
    20: "drizzle", 21: "rain", 22: "snow", 23: "mixed", 24: "freezing_rain",
    25: "rain", 26: "snow", 27: "hail", 29: "thunderstorm",
    50: "drizzle", 51: "drizzle", 52: "drizzle", 53: "drizzle",
    54: "drizzle", 55: "drizzle", 56: "drizzle",
    57: "freezing_rain", 58: "freezing_rain", 59: "freezing_rain",
    60: "freezing_rain", 61: "freezing_rain",
    62: "drizzle", 63: "drizzle",
    64: "rain", 65: "rain", 66: "rain", 67: "rain", 68: "rain", 69: "rain", 70: "rain",
    71: "freezing_rain", 72: "freezing_rain", 73: "freezing_rain",
    74: "freezing_rain", 75: "freezing_rain",
    76: "mixed", 77: "mixed",
    78: "snow", 79: "snow", 80: "snow", 81: "snow", 82: "snow", 83: "snow", 84: "snow",
    85: "ice_pellets", 86: "ice_pellets", 87: "ice_pellets", 88: "ice_pellets",
    89: "ice_pellets", 90: "ice_pellets", 91: "snow",
    92: "ice_pellets", 93: "ice_pellets", 94: "ice_pellets", 95: "ice_pellets", 96: "ice_pellets",
    97: "rain", 98: "rain", 99: "rain", 100: "rain", 101: "rain",
    102: "mixed", 103: "mixed",
    104: "snow", 105: "snow", 106: "snow", 107: "snow", 108: "snow",
    109: "hail", 110: "hail",
    111: "hail", 112: "hail", 113: "hail", 114: "hail", 115: "hail",
    116: "rain", 117: "rain", 118: "mixed", 119: "mixed",
    120: "thunderstorm", 121: "thunderstorm", 122: "thunderstorm",
    123: "thunderstorm", 124: "thunderstorm",
    145: "thunderstorm", 146: "thunderstorm",
    148: "hail", 149: "hail", 150: "hail", 151: "hail",
    152: "ice_pellets", 153: "ice_pellets", 154: "ice_pellets", 155: "ice_pellets",
}


# How far apart the SWOB observation's own timestamp and citypage's reading
# timestamp may be for the two to still be treated as the same hour's
# observation. Both update roughly hourly; 90 minutes covers a slow bulletin
# on either side without accepting an observation from a station that has
# stopped updating (the "latest" file otherwise just keeps serving its last
# value forever).
SWOB_MAX_AGE_SECONDS = 90 * 60


def fetch_swob():
    return http_get(f"{DATAMART}/today/observations/swob-ml/latest/{SWOB_STATION}-swob.xml")


def _swob_elements(root):
    """Flattens the <elements> block's <element name=... value=.../> children
    into a dict. Excludes <identification-elements>, a same-named sibling
    holding station metadata rather than observed values."""
    return {
        el.attrib["name"]: el.attrib.get("value")
        for el in root.findall(".//p:elements/p:element", SWOB_NS)
        if el.attrib.get("name")
    }


def _swob_float(elements, name):
    value = elements.get(name)
    if value is None or value == "MSNG":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_swob(xml_bytes):
    """Returns a dict of {"ts", "precipitation_mm"?, "precip_type"?} or None
    if there's nothing usable — no observation time, or neither field present
    (e.g. present_weather code is one of the many non-precipitation codes)."""
    root = ET.fromstring(xml_bytes)

    time_el = root.find(".//om:samplingTime/gml:TimeInstant/gml:timePosition", SWOB_NS)
    recorded_at = _normalize_iso(time_el.text) if time_el is not None else None
    if not recorded_at:
        return None

    elements = _swob_elements(root)
    amount_mm = _swob_float(elements, "rnfl_snc_last_syno_hr")

    precip_type = None
    code = _swob_float(elements, "prsnt_wx_1")
    if code is not None:
        precip_type = PRESENT_WEATHER_PRECIP_TYPE.get(int(code))

    if amount_mm is None and precip_type is None:
        return None

    result = {"ts": recorded_at}
    if amount_mm is not None:
        result["precipitation_mm"] = amount_mm
    if precip_type is not None:
        result["precip_type"] = precip_type
    return result


# ---------------- MQTT publishing ----------------


class ECPublisher:
    """One device (ec-victoria), polled on an hourly clock rather than a
    fixed tick — there's nothing to publish between MSC updates."""

    def __init__(self):
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"pub-{DEVICE_ID}",
        )
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.will_set(TOPIC_STATUS, "offline", qos=1, retain=True)

    def connect(self):
        self.client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            print(f"[{DEVICE_ID}] connected")
            client.publish(TOPIC_STATUS, "online", qos=1, retain=True)
        else:
            print(f"[{DEVICE_ID}] connect failed: {reason_code}")

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        print(f"[{DEVICE_ID}] disconnected ({reason_code})")

    def poll_once(self):
        xml_bytes = fetch_citypage_xml()
        reading, forecast = parse_citypage(xml_bytes)

        if reading:
            # Same underlying station (CYYJ) and hour as citypage's reading —
            # merge in the fields citypage doesn't carry, keeping citypage's
            # own "ts" as the reading's timestamp. A failure here (network,
            # bad XML) shouldn't cost us the reading/forecast/AQHI that
            # already succeeded or are still to come.
            swob = _best_effort("swob", lambda: parse_swob(fetch_swob()))
            if swob and _seconds_between(swob["ts"], reading["ts"]) <= SWOB_MAX_AGE_SECONDS:
                reading.update({k: v for k, v in swob.items() if k != "ts"})
            elif swob:
                print(f"  [skip] swob observation too stale ({swob['ts']} vs reading {reading['ts']})")
            self.client.publish(TOPIC_READING, json.dumps(reading), qos=1, retain=False)
            print(f"  {TOPIC_READING}  {json.dumps(reading)}")
        else:
            print("  [skip] no current conditions in this bulletin")

        if forecast:
            self.client.publish(TOPIC_FORECAST, json.dumps(forecast), qos=1, retain=False)
            print(f"  {TOPIC_FORECAST}  issued {forecast['issued_at']}, {len(forecast['periods'])} period(s)")
        else:
            print("  [skip] no forecast in this bulletin")

        observation, aqhi_forecast = fetch_aqhi()
        aqhi_payload = {}
        if observation:
            aqhi_payload["observation"] = observation
        if aqhi_forecast:
            aqhi_payload["forecast"] = aqhi_forecast
        if aqhi_payload:
            self.client.publish(TOPIC_AQHI, json.dumps(aqhi_payload), qos=1, retain=False)
            print(f"  {TOPIC_AQHI}  {json.dumps(aqhi_payload)}")
        else:
            print("  [skip] no AQHI data this poll")

    def shutdown(self):
        self.client.publish(TOPIC_STATUS, "offline", qos=1, retain=True)
        time.sleep(0.2)
        self.client.loop_stop()
        self.client.disconnect()


def seconds_until_next_poll(now):
    next_hour = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    target = next_hour + timedelta(seconds=POLL_DELAY)
    return max(0.0, (target - now).total_seconds())


def main():
    publisher = ECPublisher()
    try:
        publisher.connect()
    except OSError as exc:
        print(f"Could not reach broker at {BROKER_HOST}:{BROKER_PORT} — {exc}")
        sys.exit(1)

    running = {"flag": True}

    def handle_signal(signum, frame):
        running["flag"] = False

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    print(f"Polling Environment Canada hourly (device_id={DEVICE_ID}). Ctrl+C to stop.\n")

    try:
        publisher.poll_once()
    except Exception as exc:
        print(f"  [poll failed] {exc}")

    while running["flag"]:
        wait_s = seconds_until_next_poll(datetime.now(timezone.utc))
        print(f"\nNext poll in {int(wait_s)}s")
        for _ in range(int(wait_s * 10)):
            if not running["flag"]:
                break
            time.sleep(0.1)
        if not running["flag"]:
            break
        try:
            publisher.poll_once()
        except Exception as exc:
            print(f"  [poll failed] {exc}")

    print("\nShutting down...")
    publisher.shutdown()
    print("Done.")


if __name__ == "__main__":
    main()

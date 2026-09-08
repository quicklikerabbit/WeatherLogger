import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import helpers  # noqa: F401  (adds repo root to sys.path)

from ec_publisher import (
    TOPIC_AQHI,
    TOPIC_FORECAST,
    TOPIC_READING,
    ECPublisher,
    _normalize_iso,
    _seconds_between,
    fetch_aqhi,
    fetch_climate_hourly,
    parse_citypage,
)

CITYPAGE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<siteData>
  <currentConditions>
    <dateTime zone="UTC" zoneCode="UTC"><timeStamp>20240115120000</timeStamp></dateTime>
    <temperature units="C">5.2</temperature>
    <dewpoint units="C">2.1</dewpoint>
    <relativeHumidity units="%">80</relativeHumidity>
    <pressure units="kPa">101.3</pressure>
    <visibility units="km">10</visibility>
    <wind>
      <speed units="km/h">15</speed>
      <gust units="km/h">25</gust>
      <bearing units="degrees">270</bearing>
    </wind>
  </currentConditions>
  <forecastGroup>
    <dateTime zone="UTC" zoneCode="UTC"><timeStamp>20240115130000</timeStamp></dateTime>
    <forecast>
      <period textForecastName="Tonight"/>
      <textSummary>Clear</textSummary>
      <abbreviatedForecast><pop units="%">20</pop></abbreviatedForecast>
      <temperatures><temperature class="low" units="C">-2</temperature></temperatures>
      <precipitation>
        <precipType start="20" end="23">rain</precipType>
      </precipitation>
    </forecast>
  </forecastGroup>
</siteData>
"""

def _recent_utc_date(hours_ago=1):
    """fetch_climate_hourly checks its record's age against the real wall
    clock, so fixture timestamps (unlike citypage/AQHI's) must be relative
    to now rather than a fixed date."""
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S")


def _climate_hourly_json(precip=0.4, flag=None, utc_date=None):
    if utc_date is None:
        utc_date = _recent_utc_date()
    return json.dumps({
        "features": [{
            "properties": {
                "PRECIP_AMOUNT": precip,
                "PRECIP_AMOUNT_FLAG": flag,
                "UTC_DATE": utc_date,
            },
        }],
    }).encode()


class NormalizeIsoTests(unittest.TestCase):
    def test_passes_through_the_canonical_form(self):
        self.assertEqual(_normalize_iso("2024-01-15T12:00:00Z"), "2024-01-15T12:00:00Z")

    def test_converts_a_numeric_offset_to_utc(self):
        self.assertEqual(_normalize_iso("2024-01-15T12:00:00-08:00"), "2024-01-15T20:00:00Z")

    def test_drops_fractional_seconds(self):
        self.assertEqual(_normalize_iso("2024-01-15T12:00:00.500+00:00"), "2024-01-15T12:00:00Z")

    def test_none_for_missing_or_unparseable_input(self):
        self.assertIsNone(_normalize_iso(None))
        self.assertIsNone(_normalize_iso(""))
        self.assertIsNone(_normalize_iso("not-a-timestamp"))


class ParseCitypageTests(unittest.TestCase):
    def test_parses_current_conditions_and_forecast(self):
        reading, forecast = parse_citypage(CITYPAGE_XML)

        self.assertEqual(reading["ts"], "2024-01-15T12:00:00Z")
        self.assertEqual(reading["temperature"], 5.2)
        self.assertEqual(reading["pressure"], 1013.0)  # kPa -> hPa

        self.assertEqual(forecast["issued_at"], "2024-01-15T13:00:00Z")
        self.assertEqual(len(forecast["periods"]), 1)
        period = forecast["periods"][0]
        self.assertEqual(period["name"], "Tonight")
        self.assertEqual(period["temp_class"], "low")
        self.assertEqual(period["temperature"], -2.0)
        self.assertEqual(period["pop"], 20.0)
        self.assertEqual(period["precip_type"], "rain")
        self.assertEqual(period["summary"], "Clear")

    def test_missing_sections_yield_none_without_raising(self):
        reading, forecast = parse_citypage(b"<siteData></siteData>")
        self.assertIsNone(reading)
        self.assertIsNone(forecast)

    def test_joins_multiple_precip_types_in_one_period(self):
        xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<siteData>
  <forecastGroup>
    <dateTime zone="UTC" zoneCode="UTC"><timeStamp>20240115130000</timeStamp></dateTime>
    <forecast>
      <period textForecastName="Tonight"/>
      <precipitation>
        <precipType start="20" end="23">rain</precipType>
        <precipType start="23" end="29">snow</precipType>
      </precipitation>
    </forecast>
  </forecastGroup>
</siteData>
"""
        _, forecast = parse_citypage(xml)
        self.assertEqual(forecast["periods"][0]["precip_type"], "rain,snow")


class FetchClimateHourlyTests(unittest.TestCase):
    @patch("ec_publisher.http_get")
    def test_parses_amount_and_timestamp(self, http_get):
        ts = _recent_utc_date(hours_ago=2)
        http_get.return_value = _climate_hourly_json(precip=0.4, utc_date=ts)
        result = fetch_climate_hourly()
        self.assertEqual(result, {"ts": ts + "Z", "precipitation_mm": 0.4})

    @patch("ec_publisher.http_get")
    def test_includes_quality_flag_when_present(self, http_get):
        http_get.return_value = _climate_hourly_json(precip=0.0, flag="T")
        result = fetch_climate_hourly()
        self.assertEqual(result["quality_flag"], "T")

    @patch("ec_publisher.http_get")
    def test_no_flag_key_when_flag_is_null(self, http_get):
        http_get.return_value = _climate_hourly_json(flag=None)
        result = fetch_climate_hourly()
        self.assertNotIn("quality_flag", result)

    @patch("ec_publisher.http_get")
    def test_none_when_no_features(self, http_get):
        http_get.return_value = json.dumps({"features": []}).encode()
        self.assertIsNone(fetch_climate_hourly())

    @patch("ec_publisher.http_get")
    def test_none_when_amount_missing(self, http_get):
        http_get.return_value = json.dumps({
            "features": [{"properties": {"PRECIP_AMOUNT": None, "UTC_DATE": _recent_utc_date()}}],
        }).encode()
        self.assertIsNone(fetch_climate_hourly())

    @patch("ec_publisher.http_get")
    def test_none_when_the_latest_hour_is_too_old(self, http_get):
        # The archive stopped advancing — this shouldn't republish a
        # years-stale value as if it were current.
        http_get.return_value = _climate_hourly_json(utc_date="2000-01-01T00:00:00")
        self.assertIsNone(fetch_climate_hourly())


class SecondsBetweenTests(unittest.TestCase):
    def test_zero_for_identical_timestamps(self):
        self.assertEqual(_seconds_between("2024-01-15T12:00:00Z", "2024-01-15T12:00:00Z"), 0)

    def test_symmetric_regardless_of_argument_order(self):
        a, b = "2024-01-15T12:00:00Z", "2024-01-15T13:30:00Z"
        self.assertEqual(_seconds_between(a, b), 5400)
        self.assertEqual(_seconds_between(b, a), 5400)


class PollOnceTests(unittest.TestCase):
    def _publisher(self):
        pub = ECPublisher()
        pub.client.publish = MagicMock()
        return pub

    def _published_topics(self, pub):
        return [call.args[0] for call in pub.client.publish.call_args_list]

    def _published(self, pub, topic):
        for call in pub.client.publish.call_args_list:
            if call.args[0] == topic:
                return json.loads(call.args[1])
        return None

    def _published_all(self, pub, topic):
        return [json.loads(call.args[1]) for call in pub.client.publish.call_args_list if call.args[0] == topic]

    @patch("ec_publisher.fetch_aqhi", return_value=(None, None))
    @patch("ec_publisher.fetch_climate_hourly", side_effect=RuntimeError("connection reset"))
    @patch("ec_publisher.fetch_citypage_xml", return_value=CITYPAGE_XML)
    def test_climate_hourly_failure_does_not_block_reading_or_forecast(self, *_mocks):
        pub = self._publisher()
        pub.poll_once()
        topics = self._published_topics(pub)
        self.assertIn(TOPIC_READING, topics)
        self.assertIn(TOPIC_FORECAST, topics)

    @patch("ec_publisher.fetch_aqhi", return_value=(None, None))
    @patch("ec_publisher.fetch_climate_hourly",
           return_value={"ts": "2024-01-15T06:00:00Z", "precipitation_mm": 2.4, "quality_flag": "T"})
    @patch("ec_publisher.fetch_citypage_xml", return_value=CITYPAGE_XML)
    def test_climate_hourly_precipitation_is_published_as_its_own_reading(self, *_mocks):
        pub = self._publisher()
        pub.poll_once()
        readings = self._published_all(pub, TOPIC_READING)
        self.assertEqual(len(readings), 2)

        citypage_reading = next(r for r in readings if "temperature" in r)
        precip_reading = next(r for r in readings if "precipitation_mm" in r)

        # citypage's reading isn't touched by the precipitation reading —
        # each keeps its own source's timestamp rather than one overwriting
        # the other.
        self.assertEqual(citypage_reading["ts"], "2024-01-15T12:00:00Z")
        self.assertEqual(precip_reading, {
            "ts": "2024-01-15T06:00:00Z",
            "precipitation_mm": 2.4,
            "precipitation_mm_flag": "T",
        })

    @patch("ec_publisher.fetch_aqhi", return_value=(None, None))
    @patch("ec_publisher.fetch_climate_hourly", return_value=None)
    @patch("ec_publisher.fetch_citypage_xml", return_value=CITYPAGE_XML)
    def test_no_extra_reading_when_climate_hourly_has_nothing_recent_enough(self, *_mocks):
        pub = self._publisher()
        pub.poll_once()
        readings = self._published_all(pub, TOPIC_READING)
        self.assertEqual(len(readings), 1)
        self.assertNotIn("precipitation_mm", readings[0])


class FetchAqhiTests(unittest.TestCase):
    def test_normalizes_timestamps_and_shapes_the_payload(self):
        def fake_fetch(kind):
            if kind == "observation":
                return {"properties": {"aqhi": 3, "observation_datetime": "2024-01-15T12:00:00Z"}}
            return {
                "features": [{
                    "properties": {
                        "aqhi_type": "AQHI-Forecast-Period",
                        # Not strict %Y-%m-%dT%H:%M:%SZ — this is exactly
                        # the case _normalize_iso exists to handle.
                        "publication_datetime": "2024-01-15T13:00:00-08:00",
                        "forecast_period": {
                            "p1": {"forecast_period_en": "Today", "aqhi": 4},
                            "p2": {"forecast_period_en": "Tonight", "aqhi": 3},
                        },
                    },
                }],
            }

        with patch("ec_publisher._fetch_latest_aqhi", side_effect=fake_fetch):
            observation, forecast = fetch_aqhi()

        self.assertEqual(observation, {"valid_at": "2024-01-15T12:00:00Z", "value": 3})
        self.assertEqual(forecast["issued_at"], "2024-01-15T21:00:00Z")
        self.assertEqual(
            sorted(forecast["periods"], key=lambda p: p["name"]),
            [{"name": "Today", "value": 4}, {"name": "Tonight", "value": 3}],
        )

    def test_returns_none_when_datamart_has_nothing(self):
        with patch("ec_publisher._fetch_latest_aqhi", return_value=None):
            observation, forecast = fetch_aqhi()
        self.assertIsNone(observation)
        self.assertIsNone(forecast)


if __name__ == "__main__":
    unittest.main()

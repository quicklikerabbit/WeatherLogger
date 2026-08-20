import unittest
from unittest.mock import patch

import helpers  # noqa: F401  (adds repo root to sys.path)

from ec_publisher import _normalize_iso, fetch_aqhi, parse_citypage

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
    </forecast>
  </forecastGroup>
</siteData>
"""


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
        self.assertEqual(period["summary"], "Clear")

    def test_missing_sections_yield_none_without_raising(self):
        reading, forecast = parse_citypage(b"<siteData></siteData>")
        self.assertIsNone(reading)
        self.assertIsNone(forecast)


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

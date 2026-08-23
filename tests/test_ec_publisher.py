import json
import unittest
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
    parse_citypage,
    parse_swob,
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

SWOB_NS_DECL = (
    'xmlns:om="http://www.opengis.net/om/1.0" '
    'xmlns="http://dms.ec.gc.ca/schema/point-observation/2.0" '
    'xmlns:gml="http://www.opengis.net/gml"'
)


def _swob_xml(rainfall="2.4", present_weather="65"):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<om:ObservationCollection {SWOB_NS_DECL}>
  <om:member>
    <om:Observation>
      <om:samplingTime>
        <gml:TimeInstant><gml:timePosition>2024-01-15T12:00:00.000Z</gml:timePosition></gml:TimeInstant>
      </om:samplingTime>
      <om:result>
        <elements>
          <element name="air_temp" uom="&#176;C" value="5.2"/>
          <element name="rnfl_snc_last_syno_hr" uom="mm" value="{rainfall}"/>
          <element name="prsnt_wx_1" uom="code" value="{present_weather}"/>
        </elements>
      </om:result>
    </om:Observation>
  </om:member>
</om:ObservationCollection>
""".encode()


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


class ParseSwobTests(unittest.TestCase):
    def test_parses_rainfall_and_maps_present_weather_to_a_precip_type(self):
        result = parse_swob(_swob_xml(rainfall="2.4", present_weather="65"))
        self.assertEqual(result, {
            "ts": "2024-01-15T12:00:00Z",
            "precipitation_mm": 2.4,
            "precip_type": "rain",
        })

    def test_missing_rainfall_is_dropped_not_zero(self):
        result = parse_swob(_swob_xml(rainfall="MSNG", present_weather="65"))
        self.assertNotIn("precipitation_mm", result)
        self.assertEqual(result["precip_type"], "rain")

    def test_non_precipitation_code_yields_no_precip_type(self):
        # 125 = "No present or recent weather".
        result = parse_swob(_swob_xml(rainfall="MSNG", present_weather="125"))
        self.assertIsNone(result)

    def test_unmapped_code_with_rainfall_still_reports_the_amount(self):
        # 10 = "Mist" — not a precip_type code, but rainfall can still exist.
        result = parse_swob(_swob_xml(rainfall="0.5", present_weather="10"))
        self.assertEqual(result, {"ts": "2024-01-15T12:00:00Z", "precipitation_mm": 0.5})

    def test_none_without_a_sampling_time(self):
        xml = b"""<?xml version="1.0"?>
<om:ObservationCollection """ + SWOB_NS_DECL.encode() + b""">
  <om:member><om:Observation>
    <om:result><elements>
      <element name="rnfl_snc_last_syno_hr" value="1.0"/>
    </elements></om:result>
  </om:Observation></om:member>
</om:ObservationCollection>
"""
        self.assertIsNone(parse_swob(xml))


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

    @patch("ec_publisher.fetch_aqhi", return_value=(None, None))
    @patch("ec_publisher.fetch_swob", side_effect=RuntimeError("connection reset"))
    @patch("ec_publisher.fetch_citypage_xml", return_value=CITYPAGE_XML)
    def test_swob_failure_does_not_block_reading_or_forecast(self, *_mocks):
        pub = self._publisher()
        pub.poll_once()
        topics = self._published_topics(pub)
        self.assertIn(TOPIC_READING, topics)
        self.assertIn(TOPIC_FORECAST, topics)

    @patch("ec_publisher.fetch_aqhi", return_value=(None, None))
    @patch("ec_publisher.fetch_swob", return_value=_swob_xml())
    @patch("ec_publisher.fetch_citypage_xml", return_value=CITYPAGE_XML)
    def test_fresh_swob_observation_is_merged_into_the_reading(self, *_mocks):
        pub = self._publisher()
        pub.poll_once()
        reading = self._published(pub, TOPIC_READING)
        self.assertEqual(reading["precipitation_mm"], 2.4)
        self.assertEqual(reading["precip_type"], "rain")
        # citypage's own ts is kept, not overwritten by swob's.
        self.assertEqual(reading["ts"], "2024-01-15T12:00:00Z")

    @patch("ec_publisher.fetch_aqhi", return_value=(None, None))
    @patch("ec_publisher.fetch_swob")
    @patch("ec_publisher.fetch_citypage_xml", return_value=CITYPAGE_XML)
    def test_stale_swob_observation_is_not_merged(self, _fetch_citypage, fetch_swob, _fetch_aqhi):
        # citypage's reading is at 12:00:00Z; this swob file is 3 hours old —
        # a stalled station whose "latest" symlink hasn't moved.
        stale_xml = _swob_xml().decode().replace("2024-01-15T12:00:00.000Z", "2024-01-15T09:00:00.000Z")
        fetch_swob.return_value = stale_xml.encode()
        pub = self._publisher()
        pub.poll_once()
        reading = self._published(pub, TOPIC_READING)
        self.assertNotIn("precipitation_mm", reading)
        self.assertNotIn("precip_type", reading)


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

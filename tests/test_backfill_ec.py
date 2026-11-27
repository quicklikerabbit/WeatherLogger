import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import helpers  # noqa: F401  (adds repo root to sys.path)

from backfill_ec import build_messages, fetch_aqhi_files, fetch_citypage_bulletins
from ec_publisher import TOPIC_AQHI, TOPIC_FORECAST, TOPIC_READING
from test_ec_publisher import CITYPAGE_XML

START = datetime(2026, 11, 26, 9, 0, tzinfo=timezone.utc)
END = datetime(2026, 11, 26, 11, 0, tzinfo=timezone.utc)


def _citypage_listing(url):
    """Hour directories as Datamart has them: each holds the latest day's
    bulletins for that UTC hour, plus other sites' files."""
    hh = url.rstrip("/").rsplit("/", 1)[-1]
    return [
        f"20261126T{hh}0401.021Z_MSC_CitypageWeather_s0000775_en.xml",
        f"20261126T{hh}2026.025Z_MSC_CitypageWeather_s0000775_en.xml",
        f"20261126T{hh}0401.021Z_MSC_CitypageWeather_s0000775_fr.xml",
        f"20261126T{hh}0401.021Z_MSC_CitypageWeather_s0000141_en.xml",
    ]


class FetchCitypageBulletinsTests(unittest.TestCase):
    @patch("backfill_ec.http_get", return_value=CITYPAGE_XML)
    @patch("backfill_ec.list_directory", side_effect=_citypage_listing)
    def test_every_victoria_english_bulletin_in_each_hour_in_order(self, listing, http_get):
        names = [name for name, _ in fetch_citypage_bulletins(START, END)]
        self.assertEqual(names, [
            "20261126T090401.021Z_MSC_CitypageWeather_s0000775_en.xml",
            "20261126T092026.025Z_MSC_CitypageWeather_s0000775_en.xml",
            "20261126T100401.021Z_MSC_CitypageWeather_s0000775_en.xml",
            "20261126T102026.025Z_MSC_CitypageWeather_s0000775_en.xml",
        ])
        self.assertEqual(
            [call.args[0] for call in listing.call_args_list],
            ["https://dd.weather.gc.ca/today/citypage_weather/BC/09/",
             "https://dd.weather.gc.ca/today/citypage_weather/BC/10/"],
        )

    @patch("backfill_ec.http_get", return_value=CITYPAGE_XML)
    @patch("backfill_ec.list_directory", side_effect=_citypage_listing)
    def test_ignores_a_newer_days_bulletin_for_an_expired_hour(self, _listing, _http_get):
        # Asking for the 25th: the hour directories only hold the 26th's
        # bulletins now, which must not be mistaken for the 25th's.
        start = datetime(2026, 11, 25, 9, 0, tzinfo=timezone.utc)
        end = datetime(2026, 11, 25, 11, 0, tzinfo=timezone.utc)
        self.assertEqual(fetch_citypage_bulletins(start, end), [])


class FetchAqhiFilesTests(unittest.TestCase):
    @patch("backfill_ec.http_get", return_value=b"{}")
    @patch("backfill_ec.list_directory")
    def test_only_files_inside_the_window_across_date_directories(self, listing, _http_get):
        def by_date(url):
            date_str = url.split("/")[3]
            return [f"{date_str}T{hh}00Z_MSC_AQHI-Observation_JBOBQ.json" for hh in ("22", "23", "00", "01")] + [
                f"{date_str}T2300Z_MSC_AQHI-Observation_OTHER.json",
            ]
        listing.side_effect = by_date

        start = datetime(2026, 11, 25, 23, 0, tzinfo=timezone.utc)
        end = datetime(2026, 11, 26, 1, 0, tzinfo=timezone.utc)
        names = [name for name, _ in fetch_aqhi_files("observation", start, end)]
        self.assertEqual(names, [
            "20261125T2300Z_MSC_AQHI-Observation_JBOBQ.json",
            "20261126T0000Z_MSC_AQHI-Observation_JBOBQ.json",
        ])
        self.assertIn("/20261125/WXO-DD/air_quality/aqhi/pyr/observation/", listing.call_args_list[0].args[0])
        self.assertIn("/20261126/WXO-DD/air_quality/aqhi/pyr/observation/", listing.call_args_list[1].args[0])


class BuildMessagesTests(unittest.TestCase):
    def test_shapes_match_the_live_publisher(self):
        observation = {"properties": {"aqhi": 2, "observation_datetime": "2026-11-26T10:00:00Z"}}
        forecast = {"features": [{"properties": {
            "aqhi_type": "AQHI-Forecast-Period",
            "publication_datetime": "2026-11-26T13:00:00Z",
            "forecast_period": {"p1": {"forecast_period_en": "Today", "aqhi": 3}},
        }}]}

        messages = build_messages(
            [("a_en.xml", CITYPAGE_XML)],
            [("obs.json", observation)],
            [("fcst.json", forecast)],
        )

        topics = [topic for topic, _ in messages]
        self.assertEqual(topics, [TOPIC_READING, TOPIC_FORECAST, TOPIC_AQHI, TOPIC_AQHI])
        self.assertEqual(messages[0][1]["ts"], "2024-01-15T12:00:00Z")
        self.assertEqual(messages[2][1], {"observation": {"valid_at": "2026-11-26T10:00:00Z", "value": 2}})
        self.assertEqual(messages[3][1], {"forecast": {
            "issued_at": "2026-11-26T13:00:00Z", "periods": [{"name": "Today", "value": 3}],
        }})
        # Round-trips as JSON, as publish() sends it.
        for _, payload in messages:
            json.dumps(payload)

    def test_unparseable_files_are_skipped_not_fatal(self):
        messages = build_messages(
            [("bad_en.xml", b"<not xml"), ("good_en.xml", CITYPAGE_XML)],
            [("obs.json", {"properties": {}})],
            [("fcst.json", {"features": []})],
        )
        self.assertEqual([topic for topic, _ in messages], [TOPIC_READING, TOPIC_FORECAST])


if __name__ == "__main__":
    unittest.main()

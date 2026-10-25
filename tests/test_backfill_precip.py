import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import helpers  # noqa: F401  (adds repo root to sys.path)

import backfill_precip
from backfill_precip import fetch_climate_range


def _hour(utc_date, precip=0.2, flag=None):
    return {"properties": {"PRECIP_AMOUNT": precip, "PRECIP_AMOUNT_FLAG": flag, "UTC_DATE": utc_date}}


def _page(features):
    return json.dumps({"features": features}).encode()


START = datetime(2024, 1, 15, tzinfo=timezone.utc)
END = datetime(2024, 1, 16, tzinfo=timezone.utc)


class FetchClimateRangeTests(unittest.TestCase):
    @patch("backfill_precip.http_get")
    def test_trims_the_padded_window_to_the_requested_utc_range(self, http_get):
        # The request window is padded a day each side (the API filters on
        # local date), so hours outside [start, end) come back and must be
        # dropped here.
        http_get.return_value = _page([
            _hour("2024-01-14T23:00:00"),
            _hour("2024-01-15T00:00:00"),
            _hour("2024-01-15T23:00:00"),
            _hour("2024-01-16T00:00:00"),
        ])
        result = fetch_climate_range(START, END)
        self.assertEqual([r["ts"] for r in result], ["2024-01-15T00:00:00Z", "2024-01-15T23:00:00Z"])

    @patch("backfill_precip.http_get")
    def test_follows_pages_until_a_short_one(self, http_get):
        with patch.object(backfill_precip, "PAGE_SIZE", 2):
            http_get.side_effect = [
                _page([_hour("2024-01-15T00:00:00"), _hour("2024-01-15T01:00:00")]),
                _page([_hour("2024-01-15T02:00:00")]),
            ]
            result = fetch_climate_range(START, END)
        self.assertEqual(len(result), 3)
        self.assertEqual(http_get.call_count, 2)
        self.assertIn("offset=2", http_get.call_args_list[1].args[0])

    @patch("backfill_precip.http_get")
    def test_skips_unparseable_hours_and_keeps_flags(self, http_get):
        http_get.return_value = _page([
            _hour("2024-01-15T00:00:00", precip=None),
            _hour("2024-01-15T01:00:00", precip=0.0, flag="T"),
        ])
        result = fetch_climate_range(START, END)
        self.assertEqual(result, [{"ts": "2024-01-15T01:00:00Z", "precipitation_mm": 0.0, "quality_flag": "T"}])


if __name__ == "__main__":
    unittest.main()

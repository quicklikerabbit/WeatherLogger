import json
import tempfile
import unittest

import helpers

from logger import Logger, is_valid_recorded_at


class LoggerTestCase(unittest.TestCase):
    """Base class: a Logger over a scratch db, never connected to MQTT."""

    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.logger = helpers.make_logger(Logger, self.tmp_dir.name)

    def tearDown(self):
        self.logger.conn.close()
        self.tmp_dir.cleanup()


class IsValidRecordedAtTests(unittest.TestCase):
    def test_accepts_the_canonical_form(self):
        self.assertTrue(is_valid_recorded_at("2024-01-15T12:00:00Z"))

    def test_rejects_non_strings(self):
        self.assertFalse(is_valid_recorded_at(1705320000))
        self.assertFalse(is_valid_recorded_at(None))

    def test_rejects_offsets_and_missing_z(self):
        self.assertFalse(is_valid_recorded_at("2024-01-15T12:00:00+00:00"))
        self.assertFalse(is_valid_recorded_at("2024-01-15T12:00:00"))

    def test_rejects_fractional_seconds(self):
        self.assertFalse(is_valid_recorded_at("2024-01-15T12:00:00.500Z"))


class HandleReadingTests(LoggerTestCase):
    def _readings(self):
        return self.logger.conn.execute(
            "SELECT device_id, metric, value, recorded_at FROM readings"
        ).fetchall()

    def test_stores_one_row_per_numeric_metric(self):
        payload = json.dumps({"ts": "2024-01-15T12:00:00Z", "temperature": 5.2, "humidity": 80})
        self.logger._handle_reading("dev1", payload.encode())
        self.assertEqual(len(self._readings()), 2)
        self.assertEqual(self.logger.rows_written, 2)

    def test_falls_back_to_receive_time_when_ts_is_malformed(self):
        payload = json.dumps({"ts": "not-a-timestamp", "temperature": 5.2})
        self.logger._handle_reading("dev1", payload.encode())
        rows = self._readings()
        self.assertEqual(len(rows), 1)
        self.assertNotEqual(rows[0][3], "not-a-timestamp")

    def test_skips_non_numeric_and_non_finite_values(self):
        payload = json.dumps({
            "ts": "2024-01-15T12:00:00Z",
            "label": "sunny",         # not numeric
            "temperature": float("nan"),  # numeric but not finite
        })
        self.logger._handle_reading("dev1", payload.encode())
        self.assertEqual(self._readings(), [])

    def test_ignores_malformed_json(self):
        self.logger._handle_reading("dev1", b"{not json")
        self.assertEqual(self._readings(), [])

    def test_ignores_non_object_payload(self):
        self.logger._handle_reading("dev1", b"[1, 2, 3]")
        self.assertEqual(self._readings(), [])

    def test_deduplicates_a_qos1_redelivery(self):
        payload = json.dumps({"ts": "2024-01-15T12:00:00Z", "temperature": 5.2})
        self.logger._handle_reading("dev1", payload.encode())
        self.logger._handle_reading("dev1", payload.encode())  # same message, redelivered
        self.assertEqual(len(self._readings()), 1)
        self.assertEqual(self.logger.rows_written, 1)


class HandleForecastTests(LoggerTestCase):
    def _periods(self):
        return self.logger.conn.execute(
            "SELECT device_id, issued_at, period_name FROM forecast_periods"
        ).fetchall()

    def test_stores_named_periods(self):
        payload = json.dumps({
            "issued_at": "2024-01-15T12:00:00Z",
            "periods": [{"name": "Tonight", "index": 0, "temperature": -2}],
        })
        self.logger._handle_forecast("ec-victoria", payload.encode())
        self.assertEqual(len(self._periods()), 1)

    def test_rejects_missing_issued_at(self):
        payload = json.dumps({"periods": [{"name": "Tonight"}]})
        self.logger._handle_forecast("ec-victoria", payload.encode())
        self.assertEqual(self._periods(), [])

    def test_skips_periods_without_a_name(self):
        payload = json.dumps({
            "issued_at": "2024-01-15T12:00:00Z",
            "periods": [{"index": 0}],
        })
        self.logger._handle_forecast("ec-victoria", payload.encode())
        self.assertEqual(self._periods(), [])

    def test_ignores_non_object_payload(self):
        self.logger._handle_forecast("ec-victoria", b"42")
        self.assertEqual(self._periods(), [])


class HandleAqhiTests(LoggerTestCase):
    def _rows(self):
        return self.logger.conn.execute(
            "SELECT kind, valid_at, period_name, value FROM aqhi"
        ).fetchall()

    def test_stores_observation_and_forecast_periods(self):
        payload = json.dumps({
            "observation": {"valid_at": "2024-01-15T12:00:00Z", "value": 3},
            "forecast": {
                "issued_at": "2024-01-15T13:00:00Z",
                "periods": [{"name": "Today", "value": 4}, {"name": "Tonight", "value": 3}],
            },
        })
        self.logger._handle_aqhi("ec-victoria", payload.encode())
        rows = self._rows()
        self.assertEqual(len(rows), 3)
        self.assertEqual({r[0] for r in rows}, {"observation", "forecast"})

    def test_observation_row_uses_empty_period_name(self):
        # period_name defaults to '' for observations, not NULL, since the
        # dedup unique index treats NULL != NULL — see schema.sql.
        payload = json.dumps({"observation": {"valid_at": "2024-01-15T12:00:00Z", "value": 3}})
        self.logger._handle_aqhi("ec-victoria", payload.encode())
        self.assertEqual(self._rows(), [("observation", "2024-01-15T12:00:00Z", "", 3.0)])

    def test_rejects_invalid_valid_at(self):
        payload = json.dumps({"observation": {"valid_at": "not-a-timestamp", "value": 3}})
        self.logger._handle_aqhi("ec-victoria", payload.encode())
        self.assertEqual(self._rows(), [])

    def test_ignores_non_object_payload(self):
        self.logger._handle_aqhi("ec-victoria", b'"just a string"')
        self.assertEqual(self._rows(), [])


if __name__ == "__main__":
    unittest.main()

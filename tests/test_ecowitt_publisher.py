import json
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import helpers  # noqa: F401  (adds repo root to sys.path)

from ecowitt_publisher import (
    DEFAULT_INTERVAL_S,
    STALE_AFTER_INTERVALS,
    EcowittBridge,
    parse_ecowitt,
    reading_topic,
    status_topic,
    upload_interval,
)

GATEWAY = "gw3000b"
WN31 = "wn31-ch1"
WN31_CH2 = "wn31-ch2"

# A real GW3000B upload, captured off the broker (PASSKEY redacted).
UPLOAD = (
    b"PASSKEY=REDACTED&stationtype=GW3000B_V1.2.6&runtime=5497&heap=67716"
    b"&rstreason=3&dateutc=2026-11-26%2019%3A54%3A50&dns_err_cnt=0&cdnflg=3"
    b"&tempinf=70.34&humidityin=51&baromrelin=29.710&baromabsin=29.710"
    b"&freq=915M&model=GW3000B&interval=60"
)
# The same upload with a WN31 paired on channel 1, which adds its fields
# (including a battery flag, 0 = OK) to the gateway's payload.
UPLOAD_WITH_WN31 = UPLOAD.replace(
    b"&freq=", b"&temp1f=45.30&humidity1=88&batt1=0&freq="
)
# Close enough to the upload's dateutc for its clock to be trusted.
NOW = datetime(2026, 11, 26, 19, 55, 0, tzinfo=timezone.utc)


class ParseEcowittTests(unittest.TestCase):
    def test_translates_a_real_upload(self):
        self.assertEqual(parse_ecowitt(UPLOAD, now=NOW), {
            GATEWAY: {
                "ts": "2026-11-26T19:54:50Z",
                "temperature": 21.3,  # 70.34°F
                "humidity": 51.0,
                "pressure": 1006.1,  # 29.710 inHg, relative
            },
        })

    def test_splits_the_wn31_into_its_own_device(self):
        readings = parse_ecowitt(UPLOAD_WITH_WN31, now=NOW)
        self.assertEqual(readings[WN31], {
            "ts": "2026-11-26T19:54:50Z",
            "temperature": 7.39,  # 45.30°F
            "humidity": 88.0,
            "battery_low": 0.0,
        })
        # The gateway's own reading is unaffected by the WN31's fields.
        self.assertEqual(readings[GATEWAY], parse_ecowitt(UPLOAD, now=NOW)[GATEWAY])

    def test_two_wn31s_are_split_by_channel(self):
        upload = UPLOAD_WITH_WN31.replace(
            b"&freq=", b"&temp2f=50.00&humidity2=75&batt2=1&freq="
        )
        readings = parse_ecowitt(upload, now=NOW)
        self.assertEqual(readings[WN31_CH2], {
            "ts": "2026-11-26T19:54:50Z",
            "temperature": 10.0,  # 50.00°F
            "humidity": 75.0,
            "battery_low": 1.0,
        })
        # Channel 1's reading is unaffected by channel 2's fields.
        self.assertEqual(readings[WN31], parse_ecowitt(UPLOAD_WITH_WN31, now=NOW)[WN31])

    def test_wn31_low_battery_flag_is_passed_through(self):
        readings = parse_ecowitt(UPLOAD_WITH_WN31.replace(b"batt1=0", b"batt1=1"), now=NOW)
        self.assertEqual(readings[WN31]["battery_low"], 1.0)

    def test_wn31_only_upload_yields_only_the_wn31(self):
        readings = parse_ecowitt(b"temp1f=45.30&humidity1=88", now=NOW)
        self.assertEqual(list(readings), [WN31])

    def test_drops_passkey_and_firmware_diagnostics(self):
        for reading in parse_ecowitt(UPLOAD_WITH_WN31, now=NOW).values():
            for field in ("PASSKEY", "stationtype", "runtime", "heap", "freq", "model",
                          "interval", "batt1"):  # batt1 arrives renamed, as battery_low
                self.assertNotIn(field, reading)

    def test_accepts_str_as_well_as_bytes(self):
        self.assertEqual(parse_ecowitt(UPLOAD.decode(), now=NOW), parse_ecowitt(UPLOAD, now=NOW))

    def test_omits_ts_when_gateway_clock_is_skewed(self):
        # e.g. just after boot, before the gateway has synced NTP
        readings = parse_ecowitt(b"dateutc=1970-01-01%2000%3A01%3A00&tempinf=70.34&temp1f=45.30",
                                 now=NOW)
        self.assertEqual(readings, {GATEWAY: {"temperature": 21.3}, WN31: {"temperature": 7.39}})

    def test_omits_ts_when_dateutc_is_missing_or_unparseable(self):
        self.assertNotIn("ts", parse_ecowitt(b"tempinf=70.34", now=NOW)[GATEWAY])
        self.assertNotIn("ts", parse_ecowitt(b"dateutc=now&tempinf=70.34", now=NOW)[GATEWAY])

    def test_skips_a_non_numeric_field_but_keeps_the_rest(self):
        readings = parse_ecowitt(b"tempinf=--&humidityin=51", now=NOW)
        self.assertEqual(readings, {GATEWAY: {"humidity": 51.0}})

    def test_device_with_no_usable_fields_is_left_out(self):
        # e.g. the WN31 has lost contact and the gateway reports placeholders
        readings = parse_ecowitt(UPLOAD.replace(b"&freq=", b"&temp1f=--&humidity1=--&freq="),
                                 now=NOW)
        self.assertEqual(list(readings), [GATEWAY])

    def test_empty_when_nothing_usable(self):
        self.assertEqual(parse_ecowitt(b"PASSKEY=x&runtime=1", now=NOW), {})
        self.assertEqual(parse_ecowitt(b"", now=NOW), {})


class UploadIntervalTests(unittest.TestCase):
    def test_reads_the_gateways_interval(self):
        self.assertEqual(upload_interval(UPLOAD), 60)

    def test_none_when_missing_or_invalid(self):
        self.assertIsNone(upload_interval(b"tempinf=70"))
        self.assertIsNone(upload_interval(b"interval=abc"))
        self.assertIsNone(upload_interval(b"interval=0"))


class BridgeTests(unittest.TestCase):
    def _bridge(self):
        bridge = EcowittBridge()
        bridge.client.publish = MagicMock()
        return bridge

    def _published(self, bridge, topic):
        return [call.args[1] for call in bridge.client.publish.call_args_list if call.args[0] == topic]

    def test_upload_publishes_a_json_reading_and_goes_online(self):
        bridge = self._bridge()
        bridge.handle_upload(UPLOAD)
        readings = [json.loads(p) for p in self._published(bridge, reading_topic(GATEWAY))]
        self.assertEqual(len(readings), 1)
        self.assertEqual(readings[0]["humidity"], 51.0)
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)), ["online"])
        self.assertEqual(self._published(bridge, reading_topic(WN31)), [])

    def test_wn31_is_published_and_announced_under_its_own_topics(self):
        bridge = self._bridge()
        bridge.handle_upload(UPLOAD_WITH_WN31)
        readings = [json.loads(p) for p in self._published(bridge, reading_topic(WN31))]
        # ts depends on the real clock here (handle_upload doesn't take
        # `now`), so it's covered by the parse_ecowitt tests instead.
        for reading in readings:
            reading.pop("ts", None)
        self.assertEqual(readings, [{"temperature": 7.39, "humidity": 88.0, "battery_low": 0.0}])
        self.assertEqual(self._published(bridge, status_topic(WN31)), ["online"])
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)), ["online"])

    def test_online_is_only_announced_once(self):
        bridge = self._bridge()
        bridge.handle_upload(UPLOAD_WITH_WN31)
        bridge.handle_upload(UPLOAD_WITH_WN31)
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)), ["online"])
        self.assertEqual(self._published(bridge, status_topic(WN31)), ["online"])

    def test_unusable_upload_publishes_nothing(self):
        bridge = self._bridge()
        bridge.handle_upload(b"PASSKEY=x&runtime=1")
        bridge.client.publish.assert_not_called()

    @patch("ecowitt_publisher.time.monotonic")
    def test_goes_offline_after_missed_uploads_and_back_online_on_the_next(self, monotonic):
        bridge = self._bridge()
        monotonic.return_value = 1000.0
        bridge.handle_upload(UPLOAD)

        # Just inside the window: still online.
        monotonic.return_value = 1000.0 + DEFAULT_INTERVAL_S * STALE_AFTER_INTERVALS
        bridge.check_stale()
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)), ["online"])

        monotonic.return_value += 1
        bridge.check_stale()
        bridge.check_stale()  # offline is only announced once, too
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)), ["online", "offline"])

        bridge.handle_upload(UPLOAD)
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)),
                         ["online", "offline", "online"])

    @patch("ecowitt_publisher.time.monotonic")
    def test_wn31_goes_offline_on_its_own_while_the_gateway_keeps_uploading(self, monotonic):
        bridge = self._bridge()
        monotonic.return_value = 1000.0
        bridge.handle_upload(UPLOAD_WITH_WN31)

        # The WN31 drops out (e.g. dead battery); the gateway carries on.
        for _ in range(STALE_AFTER_INTERVALS + 1):
            monotonic.return_value += DEFAULT_INTERVAL_S
            bridge.handle_upload(UPLOAD)
            bridge.check_stale()

        self.assertEqual(self._published(bridge, status_topic(WN31)), ["online", "offline"])
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)), ["online"])

    @patch("ecowitt_publisher.time.monotonic")
    def test_staleness_window_follows_the_gateways_reported_interval(self, monotonic):
        bridge = self._bridge()
        monotonic.return_value = 1000.0
        bridge.handle_upload(UPLOAD.replace(b"interval=60", b"interval=16"))

        monotonic.return_value = 1000.0 + 16 * STALE_AFTER_INTERVALS + 1
        bridge.check_stale()
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)), ["online", "offline"])

    def test_no_offline_before_the_first_upload(self):
        bridge = self._bridge()
        bridge.check_stale()
        bridge.client.publish.assert_not_called()

    @patch("ecowitt_publisher.time.sleep")
    def test_shutdown_marks_every_online_device_offline(self, _sleep):
        bridge = self._bridge()
        bridge.client.loop_stop = MagicMock()
        bridge.client.disconnect = MagicMock()
        bridge.handle_upload(UPLOAD_WITH_WN31)
        bridge.shutdown()
        self.assertEqual(self._published(bridge, status_topic(GATEWAY)), ["online", "offline"])
        self.assertEqual(self._published(bridge, status_topic(WN31)), ["online", "offline"])


if __name__ == "__main__":
    unittest.main()

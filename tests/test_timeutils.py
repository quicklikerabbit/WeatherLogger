import unittest

import helpers  # noqa: F401  (adds repo root to sys.path)

from timeutils import utc_now_iso


class UtcNowIsoTests(unittest.TestCase):
    def test_matches_the_strict_form_logger_requires(self):
        # logger.is_valid_recorded_at() only accepts exactly this shape —
        # every publisher's timestamps have to round-trip through it.
        self.assertRegex(utc_now_iso(), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


if __name__ == "__main__":
    unittest.main()

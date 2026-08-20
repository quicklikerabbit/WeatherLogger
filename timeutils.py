"""Shared UTC timestamp helper for the logger and publishers.

The whole project standardizes on one string form for timestamps —
%Y-%m-%dT%H:%M:%SZ — so that logger.py's is_valid_recorded_at() can
validate what every publisher sends without per-publisher exceptions.
"""

from datetime import datetime, timezone


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

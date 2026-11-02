"""Point-in-time helpers (spec §1.2). Stdlib only, so it is unit-tested without pandas/mongo.

known_at  = when info became public/usable (UTC).
as_of_date = first trading date a strategy may act on it (first session whose open > known_at,
             or the same date for EOD prices).
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

try:
    from zoneinfo import ZoneInfo

    ET = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover
    ET = timezone.utc

UTC = timezone.utc


def to_utc(dt: datetime) -> datetime:
    """Normalize any datetime to aware UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def et_time_on(d, hour: int, minute: int) -> datetime:
    """A wall-clock ET time on trading date `d`, as aware UTC (DST-correct)."""
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=ET).astimezone(UTC)


def eod_known_at(d) -> datetime:
    """EOD prices become usable at the 16:00 ET close of that date."""
    return et_time_on(d, 16, 0)


def earnings_known_at(d, timing: str) -> datetime:
    """BMO -> 09:30 ET that day; AMC/unknown -> 16:00 ET that day (acts next session)."""
    return et_time_on(d, 9, 30) if timing == "bmo" else et_time_on(d, 16, 0)


def as_of_from_known_at(known_at: datetime, sessions, same_day: bool = False):
    """First trading date to act on `known_at`.

    sessions: ascending list of (date, open_utc). For EOD (`same_day=True`), the as_of is the
    session on known_at's own date; otherwise the first session whose open is strictly after known_at.
    """
    known_at = to_utc(known_at)
    if same_day:
        kd = known_at.astimezone(ET).date()
        for d, _open in sessions:
            if d == kd:
                return d
            if d > kd:
                return d  # known_at fell on a holiday/weekend: next session
        return None
    for d, open_utc in sessions:
        if to_utc(open_utc) > known_at:
            return d
    return None


def trading_date_to_dt(d) -> datetime:
    """Store a trading date as midnight-UTC datetime (spec §1.7)."""
    return datetime(d.year, d.month, d.day, tzinfo=UTC)

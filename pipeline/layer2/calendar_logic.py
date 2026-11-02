"""Pure row-shaping for `trading_calendar` (spec §3.1). Stdlib only -> unit-tested."""
from __future__ import annotations

from datetime import datetime, timezone

UTC = timezone.utc
REGULAR_CLOSE = (16, 0)


def shape_calendar(sessions: list[tuple]) -> list[dict]:
    """sessions: ascending list of (date, open_utc, close_utc). Returns calendar rows with
    prev/next links and an early-close flag (close before 16:00 ET ~ 20:00 UTC in standard time;
    we flag any close earlier than the modal close for that session's month-agnostic 16:00 wall time
    by comparing to the max close seen — callers pass true closes, so compare per-row to 16:00 local
    via the provided close_utc hour heuristic)."""
    rows: list[dict] = []
    for i, (d, open_utc, close_utc) in enumerate(sessions):
        prev_d = sessions[i - 1][0] if i > 0 else None
        next_d = sessions[i + 1][0] if i + 1 < len(sessions) else None
        rows.append(
            {
                "date": datetime(d.year, d.month, d.day, tzinfo=UTC),
                "is_trading_day": True,
                "open_utc": _utc(open_utc),
                "close_utc": _utc(close_utc),
                "is_early_close": _is_early_close(close_utc),
                "prev_trading_day": datetime(prev_d.year, prev_d.month, prev_d.day, tzinfo=UTC) if prev_d else None,
                "next_trading_day": datetime(next_d.year, next_d.month, next_d.day, tzinfo=UTC) if next_d else None,
            }
        )
    return rows


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _is_early_close(close_utc: datetime) -> bool:
    """Early close = NYSE 13:00 ET (half day) instead of 16:00 ET. In UTC the regular close is
    20:00 (EST) or 20:00? -> ET 16:00 = 20:00/21:00 UTC; half-day 13:00 ET = 17:00/18:00 UTC.
    Flag closes at or before 18:30 UTC as early (robust across DST)."""
    c = _utc(close_utc)
    return (c.hour, c.minute) <= (18, 30)

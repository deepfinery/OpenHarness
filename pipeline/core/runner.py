"""Transform registry + run() dispatcher (spec §1.5, §6).

Every transform is `def build(ctx) -> dict` registered by name. A harness code node calls
`pipeline.run("build_prices_daily", start="2020-01-01", end="2020-12-31")`. Daily == 1-day range.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

UTC = timezone.utc
_REGISTRY: dict = {}


def transform(name: str):
    def deco(fn):
        _REGISTRY[name] = fn
        return fn

    return deco


@dataclass
class Context:
    name: str
    start: date | None
    end: date | None
    security_ids: list[str] | None
    config: dict = field(default_factory=dict)
    rows_read: int = 0
    rows_written: int = 0
    dq: dict = field(default_factory=lambda: {"info": 0, "warn": 0, "error": 0})

    def note_dq(self, severity: str, n: int = 1):
        self.dq[severity] = self.dq.get(severity, 0) + n


def _as_date(v):
    if v is None or isinstance(v, date):
        return v
    return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()


def run(name: str, start=None, end=None, security_ids=None, config=None) -> dict:
    _ensure_loaded()
    if name not in _REGISTRY:
        raise ValueError(f"Unknown transform: {name}. Known: {sorted(_REGISTRY)}")
    ctx = Context(name, _as_date(start), _as_date(end), security_ids, config or {})
    t0 = time.time()
    status, error = "succeeded", None
    try:
        _REGISTRY[name](ctx)
    except Exception as e:  # surfaced to the harness node
        status, error = "failed", repr(e)
        raise
    finally:
        result = {
            "transform": name,
            "status": status,
            "error": error,
            "rows_read": ctx.rows_read,
            "rows_written": ctx.rows_written,
            "dq": ctx.dq,
            "duration_s": round(time.time() - t0, 2),
            "range": [str(ctx.start) if ctx.start else None, str(ctx.end) if ctx.end else None],
        }
    return result


_loaded = False


def _ensure_loaded():
    global _loaded
    if _loaded:
        return
    # Import transform modules so their @transform decorators register.
    from ..layer2 import (  # noqa: F401
        trading_calendar,
        securities,
        corporate_actions,
        prices_daily,
        macro_daily,
    )

    _loaded = True

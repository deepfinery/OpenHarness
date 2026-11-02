"""build_macro_daily (spec §3.15): treasury curve, VIX, index levels + sector returns per date.

Driven by the dates present in treasury_rates / eod_index / sector_performance (ISO strings).
Densifies once the eod_index + treasury history are backfilled.
"""
from __future__ import annotations

from ..core import pit
from ..core.runner import transform
from ._resolve import as_date

TV = "1"


@transform("build_macro_daily")
def build(ctx):
    from pymongo import ReplaceOne

    from ..core.db import coll

    tr = {r["date"]: r for r in coll("treasury_rates").find({}) if r.get("date")}
    idx: dict[str, dict] = {}
    for r in coll("eod_index").find({}):
        if r.get("symbol") and r.get("date"):
            idx.setdefault(r["symbol"], {})[r["date"]] = r.get("close")
    sectors: dict[str, dict] = {}
    for r in coll("sector_performance").find({}):
        if r.get("date"):
            sectors.setdefault(r["date"], {})[r.get("sector")] = r.get("averageChange")

    spx, vix, ndx = idx.get("^GSPC", {}), idx.get("^VIX", {}), idx.get("^IXIC", {})
    tr_dates = sorted(tr)
    dates = sorted(set(tr) | set(spx) | set(vix) | set(sectors))
    ctx.rows_read = len(tr) + sum(len(v) for v in idx.values()) + len(sectors)

    out = coll("macro_daily")
    out.create_index("date", unique=True)
    out.create_index("as_of_date")

    prev_spx = None
    ops = []
    for d in dates:
        t = tr.get(d) or _nearest_prior(tr, tr_dates, d, 3)
        s = spx.get(d)
        sret = (s / prev_spx - 1.0) if (s is not None and prev_spx) else None
        y10, y2, m3 = _g(t, "year10"), _g(t, "year2"), _g(t, "month3")
        row = {
            "date": d,
            "ust_3m": m3,
            "ust_2y": y2,
            "ust_10y": y10,
            "ust_30y": _g(t, "year30"),
            "curve_10y_2y": _sub(y10, y2),
            "curve_10y_3m": _sub(y10, m3),
            "vix": vix.get(d),
            "spx_close": s,
            "ndx_close": ndx.get(d),
            "rut_close": None,
            "spx_ret_1d": sret,
            "sector_returns": sectors.get(d, {}),
            "known_at": pit.eod_known_at(as_date(d)).isoformat(),
            "as_of_date": d,
            "transform_name": "build_macro_daily",
            "transform_version": TV,
        }
        ops.append(ReplaceOne({"date": d}, row, upsert=True))
        if s is not None:
            prev_spx = s
    if ops:
        res = out.bulk_write(ops, ordered=False)
        ctx.rows_written = (res.upserted_count or 0) + (res.modified_count or 0)


def _g(row, key):
    return row.get(key) if row else None


def _sub(a, b):
    return None if a is None or b is None else a - b


def _nearest_prior(tr, tr_dates, d, max_days):
    best = None
    for td in tr_dates:
        if td <= d:
            best = td
        else:
            break
    if best is None:
        return None
    if (as_date(d) - as_date(best)).days > max_days:
        return None
    return tr[best]

"""build_prices_daily (spec §3.3): split/div-adjusted PIT daily prices, per security.

Processed per security to bound memory. known_at = 16:00 ET close; as_of_date = same date (EOD).
Idempotent upsert on (security_id, date). Supports ctx.security_ids for smoke/partial runs.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..core import pit
from ..core.runner import transform
from .prices_logic import compute_symbol_rows
from ._resolve import security_symbols, as_date

UTC = timezone.utc
TV = "1"


@transform("build_prices_daily")
def build(ctx):
    from pymongo import ReplaceOne

    from ..core.db import coll

    securities = list(coll("securities").find({}, {"security_id": 1, "identifiers": 1}))
    sec_syms = security_symbols(securities)
    if ctx.security_ids:
        wanted = set(ctx.security_ids)
        sec_syms = {k: v for k, v in sec_syms.items() if k in wanted}

    prices, ca = coll("eod_prices"), coll("corporate_actions")
    out = coll("prices_daily")
    out.create_index([("security_id", 1), ("date", 1)], unique=True)
    out.create_index("date")
    out.create_index("as_of_date")
    dq = coll("dq_issues")

    date_range = {}
    if ctx.start:
        date_range["$gte"] = str(ctx.start)
    if ctx.end:
        date_range["$lte"] = str(ctx.end)

    total = 0
    for sid, syms in sec_syms.items():
        q = {"symbol": {"$in": list(syms)}}
        if date_range:
            q["date"] = date_range
        bars_raw = list(prices.find(q).sort("date", 1))
        if not bars_raw:
            continue
        ctx.rows_read += len(bars_raw)
        by_date = {b["date"]: b for b in bars_raw}  # collapse ticker reuse to one bar/date
        bars = [by_date[d] for d in sorted(by_date)]

        actions = list(ca.find({"security_id": sid}))
        divs = {
            a["ex_date"]: a.get("dividend_amount")
            for a in actions
            if a["action_type"] in ("cash_dividend", "special_dividend") and a.get("dividend_amount")
        }
        spl = {a["ex_date"]: a.get("split_ratio") for a in actions if a["action_type"] == "split" and a.get("split_ratio")}

        rows = compute_symbol_rows(
            [
                {k: b.get(k) for k in ("date", "open", "high", "low", "close", "volume", "vwap")}
                for b in bars
            ],
            divs,
            spl,
        )
        ops = []
        issues = []
        for r in rows:
            d = r["date"]
            doc = {
                **r,
                "security_id": sid,
                "ticker": by_date[d].get("symbol"),
                "known_at": pit.eod_known_at(as_date(d)).isoformat(),
                "as_of_date": d,
                "source_collection": "eod_prices",
                "source_ids": [str(by_date[d].get("_id"))],
                "transform_name": "build_prices_daily",
                "transform_version": TV,
                "processed_at": datetime.now(UTC).isoformat(),
            }
            ops.append(ReplaceOne({"security_id": sid, "date": d}, doc, upsert=True))
            for flag in r["dq_flags"]:
                sev = "error" if flag in ("zero_or_negative_price", "high_lt_low") else "warn"
                issues.append(
                    {
                        "collection": "prices_daily",
                        "transform_name": "build_prices_daily",
                        "severity": sev,
                        "issue_type": flag,
                        "security_id": sid,
                        "date": d,
                        "detected_at": datetime.now(UTC),
                        "resolved": False,
                    }
                )
        if ops:
            res = out.bulk_write(ops, ordered=False)
            total += (res.upserted_count or 0) + (res.modified_count or 0)
        if issues:
            dq.insert_many(issues)
            ctx.note_dq("error", sum(1 for i in issues if i["severity"] == "error"))
            ctx.note_dq("warn", sum(1 for i in issues if i["severity"] == "warn"))
    ctx.rows_written = total

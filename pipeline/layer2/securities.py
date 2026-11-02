"""build_securities (spec §3.2): master identity table seeded from stock list + profiles + delisted.

Matches by CIK, then CUSIP, then ticker+name; maintains validity intervals for ticker/sector/
industry/exchange; assigns immutable security_id. Idempotent: re-runs match existing securities.
"""
from __future__ import annotations

from datetime import datetime, timezone

from ..core.runner import transform
from .securities_logic import match_security, upsert_interval

UTC = timezone.utc
TRANSFORM_VERSION = "1"


def _match_index(docs: list[dict]) -> list[dict]:
    out = []
    for d in docs:
        tickers, cusips, cik = set(), set(), None
        for ident in d.get("identifiers", []):
            if ident["type"] == "ticker":
                tickers.add(ident["value"])
            elif ident["type"] == "cusip":
                cusips.add(ident["value"])
            elif ident["type"] == "cik":
                cik = ident["value"]
        out.append(
            {"security_id": d["security_id"], "cik": cik, "cusips": cusips, "tickers": tickers, "name": d.get("name", "")}
        )
    return out


def _set_identifier(doc: dict, id_type: str, value, valid_from):
    """Ensure an identifier of id_type==value exists; for tickers, keep validity intervals."""
    if value in (None, ""):
        return
    value = str(value)
    if id_type in ("cik", "cusip", "isin"):
        if not any(i["type"] == id_type and i["value"] == value for i in doc["identifiers"]):
            doc["identifiers"].append({"type": id_type, "value": value, "valid_from": valid_from, "valid_to": None})
        return
    # ticker: close the previous open ticker and open the new one on change
    tickers = [i for i in doc["identifiers"] if i["type"] == "ticker"]
    others = [i for i in doc["identifiers"] if i["type"] != "ticker"]
    merged = upsert_interval(
        [{"value": t["value"], "valid_from": t.get("valid_from"), "valid_to": t.get("valid_to")} for t in tickers],
        value,
        valid_from,
    )
    doc["identifiers"] = others + [{"type": "ticker", **m} for m in merged]


@transform("build_securities")
def build(ctx):
    from pymongo import ReplaceOne

    from ..core.db import coll
    from ..core.config import load
    from ..core.lineage import lineage

    cfg = (load("universe.yaml") or {}).get("securities", {})
    allowed_exch = set(cfg.get("exchanges", ["NASDAQ", "NYSE", "AMEX", "NYSE American"]))
    now = datetime.now(UTC)

    sec = coll("securities")
    sec.create_index("security_id", unique=True)
    sec.create_index([("identifiers.type", 1), ("identifiers.value", 1)])
    sec.create_index("is_active")

    existing_docs = {d["security_id"]: d for d in sec.find({})}
    match_idx = _match_index(list(existing_docs.values()))
    next_num = 1 + max((int(sid.split("_")[1]) for sid in existing_docs if sid.startswith("SEC_")), default=0)

    profiles = {p["symbol"]: p for p in coll("company_profiles").find({})}
    stock_list = {s["symbol"]: s for s in coll("stock_list").find({})}
    delisted = {d["symbol"]: d for d in coll("delisted_companies").find({})}
    ctx.rows_read = len(profiles) + len(stock_list) + len(delisted)

    # Seed from the synced profile universe + delisted; stock_list only backfills names.
    symbols = set(profiles) | set(delisted)
    touched: dict[str, dict] = {}

    for sym in sorted(symbols):
        p = profiles.get(sym, {})
        sl = stock_list.get(sym, {})
        dl = delisted.get(sym, {})
        # Filter to common stock / ADR on allowed exchanges (configurable); keep if profile missing.
        if p:
            if p.get("isEtf") or p.get("isFund"):
                continue
            exch = (p.get("exchange") or p.get("exchangeShortName") or "").upper()
            if exch and allowed_exch and not any(a.upper() in exch for a in allowed_exch):
                continue
        name = p.get("companyName") or sl.get("companyName") or dl.get("companyName") or sym
        candidate = {"ticker": sym, "cik": p.get("cik"), "cusip": p.get("cusip"), "name": name}
        sid = match_security(candidate, match_idx)
        if sid and sid in touched:
            doc = touched[sid]
        elif sid and sid in existing_docs:
            doc = dict(existing_docs[sid])
            doc.setdefault("identifiers", [])
        else:
            sid = f"SEC_{next_num:06d}"
            next_num += 1
            doc = {
                "security_id": sid,
                "name": name,
                "security_type": "ADR" if p.get("isAdr") else "common",
                "country": p.get("country"),
                "currency": p.get("currency") or "USD",
                "identifiers": [],
                "sector_history": [],
                "industry_history": [],
                "exchange_history": [],
                "ipo_date": p.get("ipoDate") or sl.get("ipoDate") or dl.get("ipoDate"),
                "is_active": True,
            }
            match_idx.append({"security_id": sid, "cik": p.get("cik"), "cusips": set(), "tickers": set(), "name": name})

        vf = doc.get("ipo_date") or "1900-01-01"
        _set_identifier(doc, "ticker", sym, vf)
        _set_identifier(doc, "cik", p.get("cik"), vf)
        _set_identifier(doc, "cusip", p.get("cusip"), vf)
        _set_identifier(doc, "isin", p.get("isin"), vf)
        if p.get("sector"):
            doc["sector_history"] = upsert_interval(doc.get("sector_history", []), p["sector"], now)
        if p.get("industry"):
            doc["industry_history"] = upsert_interval(doc.get("industry_history", []), p["industry"], now)
        exch = p.get("exchange") or p.get("exchangeShortName")
        if exch:
            doc["exchange_history"] = upsert_interval(doc.get("exchange_history", []), exch, now)
        if dl.get("delistedDate"):
            doc["delisted_date"] = dl["delistedDate"]
            doc["is_active"] = False
        elif p:
            doc["is_active"] = bool(p.get("isActivelyTrading", True))
        doc["name"] = name
        doc["_lineage"] = lineage("company_profiles", [p.get("_id")] if p else [], "build_securities", TRANSFORM_VERSION)
        touched[sid] = doc

    ops = [ReplaceOne({"security_id": sid}, doc, upsert=True) for sid, doc in touched.items()]
    if ops:
        res = sec.bulk_write(ops, ordered=False)
        ctx.rows_written = (res.upserted_count or 0) + (res.modified_count or 0)

"""Pure identity-resolution + validity-interval logic for `securities` (spec §3.2).

Stdlib only -> unit-tested without mongo. The build() orchestrator in securities.py wires these
to Layer 1 reads and Mongo writes.
"""
from __future__ import annotations

from difflib import SequenceMatcher

IDENTIFIER_TYPES = ("ticker", "cusip", "cik", "isin", "figi")


def name_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def match_security(candidate: dict, existing: list[dict], name_threshold: float = 0.88):
    """Return the security_id of the existing security the candidate refers to, else None.

    Match precedence (spec §3.2): CIK, then CUSIP, then ticker + name similarity.
    `existing` items: {security_id, cik, cusips:set, tickers:set, name}.
    """
    cik = candidate.get("cik")
    if cik:
        for s in existing:
            if s.get("cik") and str(s["cik"]) == str(cik):
                return s["security_id"]
    cusip = candidate.get("cusip")
    if cusip:
        for s in existing:
            if cusip in s.get("cusips", set()):
                return s["security_id"]
    ticker = candidate.get("ticker")
    if ticker:
        best, best_score = None, 0.0
        for s in existing:
            if ticker in s.get("tickers", set()):
                score = name_similarity(candidate.get("name", ""), s.get("name", ""))
                if score > best_score:
                    best, best_score = s["security_id"], score
        if best and best_score >= name_threshold:
            return best
    return None


def upsert_interval(intervals: list[dict], value, valid_from, valid_to=None):
    """Append a validity interval for a changing attribute (ticker/sector/industry/exchange).

    If the newest open interval already carries `value`, do nothing. Otherwise close the open
    interval at `valid_from` and open a new one. Returns the updated list (new object).
    """
    intervals = [dict(i) for i in intervals]
    open_iv = next((i for i in reversed(intervals) if i.get("valid_to") is None), None)
    if open_iv is not None and open_iv.get("value") == value:
        return intervals
    if open_iv is not None:
        open_iv["valid_to"] = valid_from
    intervals.append({"value": value, "valid_from": valid_from, "valid_to": valid_to})
    return intervals


def ticker_on(identifiers: list[dict], on_date):
    """Resolve the ticker valid on `on_date` from identifier intervals (spec §1.1)."""
    for ident in identifiers:
        if ident.get("type") != "ticker":
            continue
        vf, vt = ident.get("valid_from"), ident.get("valid_to")
        if (vf is None or vf <= on_date) and (vt is None or on_date < vt):
            return ident.get("value")
    return None


def has_ticker_collision(active: list[dict], on_date) -> list[str]:
    """Return tickers shared by >1 active security on `on_date` (validation, spec §3.2)."""
    seen: dict[str, int] = {}
    for s in active:
        t = ticker_on(s.get("identifiers", []), on_date)
        if t:
            seen[t] = seen.get(t, 0) + 1
    return [t for t, n in seen.items() if n > 1]

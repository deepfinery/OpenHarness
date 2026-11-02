"""Shared helpers for Layer 2 builds: ticker<->security_id resolution and date math."""
from __future__ import annotations

from datetime import date, timedelta


def ticker_resolver(securities: list[dict]):
    """Return resolve(symbol, on_date_iso=None) -> security_id using identifier validity intervals."""
    idx: dict[str, list] = {}
    for s in securities:
        for ident in s.get("identifiers", []):
            if ident.get("type") == "ticker":
                idx.setdefault(ident["value"], []).append(
                    (s["security_id"], _iso(ident.get("valid_from")), _iso(ident.get("valid_to")))
                )

    def resolve(symbol: str, on_date: str | None = None):
        cands = idx.get(symbol)
        if not cands:
            return None
        if len(cands) == 1:
            return cands[0][0]
        if on_date:
            for sid, vf, vt in cands:
                if (vf is None or vf <= on_date) and (vt is None or on_date < vt):
                    return sid
        return sorted(cands, key=lambda c: c[1] or "")[-1][0]

    return resolve


def security_symbols(securities: list[dict]) -> dict[str, set]:
    out: dict[str, set] = {}
    for s in securities:
        for ident in s.get("identifiers", []):
            if ident.get("type") == "ticker":
                out.setdefault(s["security_id"], set()).add(ident["value"])
    return out


def iso_minus_days(iso: str, days: int) -> str:
    return (as_date(iso) - timedelta(days=days)).isoformat()


def as_date(iso: str) -> date:
    return date.fromisoformat(str(iso)[:10])


def _iso(v):
    return None if v is None else str(v)[:10]

"""Pure split/dividend-adjustment + return + DQ logic for prices_daily (spec §3.3). Stdlib only."""
from __future__ import annotations


def split_adjustment_factors(dates, splits):
    """Backward-cumulative split factor per date so historical prices are on the current share basis.

    factor(d) = product of 1/ratio for every split whose ex_date is strictly after d.
    `dates`: iterable of comparable dates. `splits`: list of (ex_date, ratio) with ratio = new/old.
    adj_close = close * factor.
    """
    sp = [(ex, r) for ex, r in splits if r]
    out = {}
    for d in dates:
        f = 1.0
        for ex, r in sp:
            if ex > d:
                f /= r
        out[d] = f
    return out


def compute_symbol_rows(bars, dividends_by_exdate, splits_by_exdate):
    """Per-symbol price rows with adjusted OHLC, price & total returns, dollar volume, DQ flags.

    bars: ascending list of {date, open, high, low, close, volume}.
    dividends_by_exdate: {date: cash_dividend_per_share}; splits_by_exdate: {date: ratio new/old}.
    """
    dates = [b["date"] for b in bars]
    factors = split_adjustment_factors(dates, list(splits_by_exdate.items()))
    rows = []
    prev_close = None
    recent_closes: list[float] = []
    for b in bars:
        d = b["date"]
        close = _num(b.get("close"))
        f = factors.get(d, 1.0)
        r = splits_by_exdate.get(d, 1.0) or 1.0
        div = dividends_by_exdate.get(d, 0.0) or 0.0
        flags = _dq_flags(b, prev_close, r, div, recent_closes)
        ret_1d = tr_1d = None
        if prev_close and prev_close > 0 and close is not None:
            ret_1d = (close * r) / prev_close - 1.0
            tr_1d = ((close + div) * r) / prev_close - 1.0
        row = {
            "date": d,
            "open": _num(b.get("open")),
            "high": _num(b.get("high")),
            "low": _num(b.get("low")),
            "close": close,
            "volume": _num(b.get("volume")),
            "vwap": _num(b.get("vwap")),
            "adj_factor": f,
            "adj_close": _mul(close, f),
            "adj_open": _mul(_num(b.get("open")), f),
            "adj_high": _mul(_num(b.get("high")), f),
            "adj_low": _mul(_num(b.get("low")), f),
            "dollar_volume": _mul(close, _num(b.get("volume"))),
            "ret_1d": ret_1d,
            "tr_1d": tr_1d,
            "dq_flags": flags,
        }
        rows.append(row)
        if close is not None:
            prev_close = close
            recent_closes.append(close)
            if len(recent_closes) > 6:
                recent_closes.pop(0)
    return rows


def _dq_flags(b, prev_close, split_ratio, div, recent_closes):
    flags = []
    close, high, low, vol = _num(b.get("close")), _num(b.get("high")), _num(b.get("low")), _num(b.get("volume"))
    o = _num(b.get("open"))
    if close is None or close <= 0:
        flags.append("zero_or_negative_price")
    if high is not None and low is not None and high < low:
        flags.append("high_lt_low")
    if high is not None and low is not None and close is not None and not (low <= close <= high):
        flags.append("close_outside_range")
    if vol == 0:
        flags.append("zero_volume")
    if prev_close and prev_close > 0 and close is not None:
        ret = (close * (split_ratio or 1.0)) / prev_close - 1.0
        if abs(ret) > 0.5 and (split_ratio in (None, 1.0)) and not div:
            flags.append("jump_no_action")
    if close is not None and vol and vol > 0 and len(recent_closes) >= 5 and all(c == close for c in recent_closes[-5:]):
        flags.append("stale_price")
    return flags


def _num(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _mul(a, b):
    return None if a is None or b is None else a * b

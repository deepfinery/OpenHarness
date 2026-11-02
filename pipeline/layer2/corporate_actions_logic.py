"""Pure corporate-actions normalization (spec §3.4). Stdlib only."""
from __future__ import annotations


def normalize_split_ratio(numerator, denominator):
    """FMP numerator/denominator -> ratio new/old (e.g. 4-for-1 => 4.0, 1-for-10 reverse => 0.1)."""
    try:
        n, d = float(numerator), float(denominator)
    except (TypeError, ValueError):
        return None
    return n / d if d else None


def is_special_dividend(amount, trailing_regular, *, split_type=None, flagged=False, multiple=3.0):
    """Classify a dividend as special if flagged, or > `multiple` x the trailing regular dividend."""
    if flagged:
        return True
    try:
        amt = float(amount)
    except (TypeError, ValueError):
        return False
    if trailing_regular and trailing_regular > 0 and amt > multiple * float(trailing_regular):
        return True
    return False

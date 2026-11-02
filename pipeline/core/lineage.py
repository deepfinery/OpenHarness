"""Lineage + DQ helpers (spec §1.4, §1.6)."""
from __future__ import annotations

from datetime import datetime, timezone

UTC = timezone.utc


def lineage(source_collection: str, source_ids, transform_name: str, transform_version: str) -> dict:
    return {
        "source_collection": source_collection,
        "source_ids": [str(i) for i in (source_ids or [])],
        "transform_name": transform_name,
        "transform_version": transform_version,
        "processed_at": datetime.now(UTC),
    }


def dq_issue(
    collection: str,
    transform_name: str,
    severity: str,
    issue_type: str,
    *,
    security_id=None,
    date=None,
    source_ids=None,
    details=None,
) -> dict:
    assert severity in ("info", "warn", "error")
    return {
        "collection": collection,
        "transform_name": transform_name,
        "severity": severity,
        "issue_type": issue_type,
        "security_id": security_id,
        "date": date,
        "source_ids": [str(i) for i in (source_ids or [])],
        "details": details or {},
        "detected_at": datetime.now(UTC),
        "resolved": False,
    }

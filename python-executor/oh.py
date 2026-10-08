"""Helpers available to code that runs in the OpenHarness Python executor.

    import oh
    rows = oh.read("prices", {"ticker": "AAPL"}, limit=5000)   # list of dicts from a collection
    frame = oh.read_df("prices", sort=[("date", 1)])             # the same as a pandas DataFrame
    oh.write("signals", records)                                 # append documents
    oh.write_df("features", frame, mode="replace")               # replace a collection's content
    oh.result({"rows": len(rows)})                               # what the agent or workflow receives
    oh.params["window"]                                          # parameters the caller passed in

Collections are those of the calling workspace: the connection string the executor received only reaches
that database. Writes go through the trusted runner; the code never needs credentials of its own.
"""

from __future__ import annotations

import json
import os
from typing import Any, Iterable

__all__ = ["params", "read", "read_df", "write", "write_df", "result", "log", "collections"]

params: dict[str, Any] = json.loads(os.environ.get("OH_PARAMS") or "{}")
_RESULT_PATH = os.environ.get("OH_RESULT_PATH", "/work/.oh-result.json")
_client = None


def _db():
    global _client
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise RuntimeError("This job has no MongoDB collections: start it from a workspace with a MongoDB connection")
    if _client is None:
        from pymongo import MongoClient

        _client = MongoClient(uri, serverSelectionTimeoutMS=10000)
    return _client.get_default_database()


def collections() -> list[str]:
    """Names of the collections in the workspace database."""
    return sorted(n for n in _db().list_collection_names() if not n.startswith("system."))


def read(collection: str, filter: dict | None = None, *, limit: int | None = None, sort: list | None = None,
         projection: dict | None = None) -> list[dict]:
    """Documents of a collection as plain dicts (``_id`` is kept as a string)."""
    cursor = _db()[collection].find(filter or {}, projection)
    if sort:
        cursor = cursor.sort(sort)
    if limit:
        cursor = cursor.limit(int(limit))
    rows = []
    for doc in cursor:
        if "_id" in doc:
            doc["_id"] = str(doc["_id"])
        rows.append(doc)
    return rows


def read_df(collection: str, filter: dict | None = None, **kwargs):
    """A collection (or a filtered part of it) as a pandas DataFrame."""
    import pandas as pd

    rows = read(collection, filter, **kwargs)
    return pd.DataFrame(rows)


def write(collection: str, records: Iterable[dict], *, mode: str = "append") -> int:
    """Insert documents. ``mode="replace"`` empties the collection first. Returns the inserted count."""
    if mode not in ("append", "replace"):
        raise ValueError("mode must be 'append' or 'replace'")
    docs = []
    for record in records:
        if not isinstance(record, dict):
            record = {"value": record}
        record = dict(record)
        record.pop("_id", None)
        docs.append(record)
    target = _db()[collection]
    if mode == "replace":
        target.delete_many({})
    if not docs:
        return 0
    inserted = 0
    for start in range(0, len(docs), 1000):
        inserted += len(target.insert_many(docs[start : start + 1000], ordered=True).inserted_ids)
    return inserted


def write_df(collection: str, frame, *, mode: str = "append") -> int:
    """Write a pandas DataFrame (one document per row). NaN becomes null."""
    import math

    records = frame.to_dict(orient="records")
    for record in records:
        for key, value in list(record.items()):
            if isinstance(value, float) and math.isnan(value):
                record[key] = None
            elif hasattr(value, "isoformat"):
                record[key] = value.isoformat()
            elif hasattr(value, "item") and not isinstance(value, (str, bytes)):
                try:
                    record[key] = value.item()
                except (ValueError, TypeError):
                    pass
    return write(collection, records, mode=mode)


def result(value: Any) -> None:
    """Set the structured result returned to the agent or the workflow step (JSON-serializable)."""
    with open(_RESULT_PATH, "w", encoding="utf-8") as handle:
        json.dump(value, handle, default=str)


def log(*parts: Any) -> None:
    """Print a line to the job's output (visible to the agent and in the trace)."""
    print(*parts, flush=True)

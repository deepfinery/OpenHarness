"""MongoDB handle for the workspace database (the same DB Layer 1 wrote to and agents read).

In an OpenHarness executor Job, MONGODB_URI is injected and its default DB is the workspace DB.
For local/backfill runs, set MONGODB_URI (and optionally PIPELINE_DB to override the DB name).
"""
from __future__ import annotations

import functools
import os


@functools.lru_cache(maxsize=None)
def _client():
    from pymongo import MongoClient

    uri = os.environ.get("MONGODB_URI") or os.environ.get("PIPELINE_MONGODB_URI")
    if not uri:
        raise RuntimeError("Set MONGODB_URI to the workspace MongoDB connection string")
    return MongoClient(uri, serverSelectionTimeoutMS=15000)


def db():
    name = os.environ.get("PIPELINE_DB")
    return _client()[name] if name else _client().get_default_database()


def coll(name: str):
    return db()[name]

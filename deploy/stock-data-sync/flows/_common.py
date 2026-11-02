# Shared helpers prepended to every Stock-data-sync code node. Each node runs in a
# fresh executor container, so there is no shared import — the builder concatenates
# this prefix, the flow's run() body, and a wrapper that calls run() and reports.
import os, time, json, random, datetime as dt
import urllib.request, urllib.parse, urllib.error
import oh  # params / result / log, copied beside the code by the executor runner

try:
    from pymongo import MongoClient, UpdateOne
except Exception:  # pragma: no cover
    MongoClient = None

PARAMS = {}
try:
    PARAMS = dict(oh.params or {})
except Exception:
    PARAMS = json.loads(os.environ.get("OH_PARAMS") or "{}")


# Run options travel in the run input string (always present, unlike payload templates),
# e.g. input "force limit=8 pages=1 maxrpm=600". Tokens are lowercased; bare words are flags.
_DIRECTIVES = {}
for _tok in str(PARAMS.get("runInput", "")).lower().replace(",", " ").split():
    if "=" in _tok:
        _k, _v = _tok.split("=", 1)
        _DIRECTIVES[_k] = _v
    else:
        _DIRECTIVES[_tok] = True


def pint(key, default=0):
    """Int option from input directives, then params, else default. '' -> default."""
    v = _DIRECTIVES.get(key.lower(), PARAMS.get(key, default))
    try:
        return int(v) if str(v).strip() != "" else default
    except Exception:
        return default


def pbool(key):
    if _DIRECTIVES.get(key.lower()):
        return True
    return str(PARAMS.get(key, "")).strip().lower() in ("1", "true", "yes", "on")


FMP_KEY = os.environ.get("FMP_API_KEY")
FMP_BASE = "https://financialmodelingprep.com/stable"

# Pace FMP calls under the plan's per-minute limit (Premium is per-symbol). 429s back off.
MAX_RPM = pint("maxrpm", 400)
_MIN_INTERVAL = 60.0 / max(1, MAX_RPM)
_last = [0.0]
_calls = [0]


def log(*parts):
    print(*parts, flush=True)


def _throttle():
    wait = _MIN_INTERVAL - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    _calls[0] += 1


def fmp_get(path, **params):
    """GET an FMP stable endpoint with pacing + retry/backoff. Raises on 402 (tier)."""
    if not FMP_KEY:
        raise RuntimeError("FMP_API_KEY secret is not attached to this node")
    params["apikey"] = FMP_KEY
    url = f"{FMP_BASE}/{path}?" + urllib.parse.urlencode(params)
    last_err = None
    for attempt in range(6):
        _throttle()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "openharness-stock-sync"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            # 402 on the "latest" feeds is a transient per-endpoint throttle that FMP
            # mislabels "not in current plan"; retry a few times before giving up.
            if e.code in (402, 429, 500, 502, 503, 504):
                if e.code == 402 and attempt >= 3:
                    raise RuntimeError(f"FMP restricted (402) for {path}: not in current plan (after retries)")
                back = min(60.0, 2 ** attempt) + random.random()
                log(f"  FMP {e.code} on {path} -> backoff {back:.1f}s")
                time.sleep(back)
                last_err = e
                continue
            raise
        except Exception as e:  # transient network
            back = min(30.0, 2 ** attempt) + random.random()
            log(f"  FMP error on {path}: {e} -> retry {back:.1f}s")
            time.sleep(back)
            last_err = e
    raise RuntimeError(f"FMP failed after retries for {path}: {last_err}")


def _db():
    uri = os.environ.get("MONGODB_URI")
    if not uri or MongoClient is None:
        raise RuntimeError("No MONGODB_URI available in this job")
    return MongoClient(uri, serverSelectionTimeoutMS=15000).get_default_database()


def upsert(collection, docs, keys):
    """Idempotent bulk upsert on the given key fields. Adds _syncedAt. Returns write count."""
    docs = [d for d in docs if isinstance(d, dict)]
    if not docs:
        return 0
    now = dt.datetime.utcnow().isoformat() + "Z"
    ops = []
    for doc in docs:
        doc = dict(doc)
        doc.pop("_id", None)
        doc["_syncedAt"] = now
        flt = {k: doc.get(k) for k in keys}
        ops.append(UpdateOne(flt, {"$set": doc}, upsert=True))
    res = _db()[collection].bulk_write(ops, ordered=False)
    return (res.upserted_count or 0) + (res.modified_count or 0)


def ensure_index(collection, keys, unique=False):
    try:
        _db()[collection].create_index([(k, 1) for k in keys], unique=unique)
    except Exception as e:
        log(f"  index warn on {collection}: {e}")


def universe_symbols(limit=0):
    rows = list(_db()["universe"].find({}, {"symbol": 1, "_id": 0}))
    syms = [r["symbol"] for r in rows if r.get("symbol")]
    return syms[:limit] if limit else syms


def per_symbol(collection, path, keys, *, extra=None, cap=0):
    """Fetch an FMP endpoint once per universe symbol and upsert. Errors are counted, not raised."""
    syms = universe_symbols(cap)
    ensure_index(collection, keys, unique=False)
    total = errors = 0
    for i, sym in enumerate(syms):
        try:
            p = dict(extra or {})
            p["symbol"] = sym
            rows = fmp_get(path, **p)
            if isinstance(rows, dict):
                rows = [rows]
            if not isinstance(rows, list):
                rows = []
            for r in rows:
                if isinstance(r, dict):
                    r.setdefault("symbol", sym)
            total += upsert(collection, rows, keys)
        except Exception as e:
            errors += 1
            if errors <= 5:
                log(f"  {collection} error {sym}: {e}")
        if (i + 1) % 250 == 0:
            log(f"  {collection} {i + 1}/{len(syms)} written={total} errors={errors}")
    return {"symbols": len(syms), "rowsWritten": total, "errors": errors}


def recent_reporters(lookback_days=3, cap=0):
    """Symbols that reported in the last N days, from a small past-window earnings-calendar
    call (avoids the endpoint's 4000-row cap that drops past dates on a wide window)."""
    start = (now_et() - dt.timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    today = now_et().strftime("%Y-%m-%d")
    rows = fmp_get("earnings-calendar", **{"from": start, "to": today})
    syms = sorted({r["symbol"] for r in rows if r.get("symbol")})
    return syms[:cap] if cap else syms


def now_et():
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo(PARAMS.get("timezone") or "America/New_York"))
    except Exception:
        return dt.datetime.utcnow()


def due_weekly(weekday=5):
    """True when forced (one-off) or today (ET) is the target weekday (0=Mon..6=Sun; 5=Sat)."""
    if pbool("force"):
        return True
    return now_et().weekday() == pint("weekday", weekday)

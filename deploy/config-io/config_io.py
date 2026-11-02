#!/usr/bin/env python3
"""Export and import StockHarness CONFIGURATIONS (not data, not secrets).

Covers the resources you author: dataset syncs (JSON), harness workflows incl. their Python code
(YAML), agents (YAML), and skills (YAML). Server-managed fields (ids, timestamps, cursors, discovered
tools, run state) are stripped. Environment-specific references (connectionId, providerId, agentId,
knowledgeBaseId, guardrailIds, ...) are stored BY NAME as {"$ref": {type, name}} so nothing secret is
exported and an import resolves them against the target install.

Usage:
    OH_BASE=https://openharness.faberiq.ai OH_EMAIL=you@example.com OH_PASSWORD=... \\
      python config_io.py export [--dir exports]
    OH_BASE=... OH_EMAIL=... OH_PASSWORD=... python config_io.py apply [--dir exports] [--dry-run]

Import prerequisites: the connections, providers, and knowledge bases referenced by name must already
exist on the target (they hold secrets and are created per install). Apply is idempotent by name
(update if present, else create) and runs in dependency order: skills, agents, workflows, dataset syncs.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import urllib.request
from pathlib import Path

SERVER_FIELDS = {
    "id", "_id", "ownerId", "createdAt", "updatedAt", "createdBy", "updatedBy", "revision",
    "cursor", "nextRunAt", "lastRunAt", "lastError", "lastRows", "lastCheckedAt",
    "lastScheduleError", "status", "tools", "mcpResources", "mcpPrompts", "lastRun",
}
# (export file, list GET path, write/create path, yaml?)
EXPORT_TYPES = {
    "datasetSyncs": ("dataset-syncs.json", "/datasetSyncs", "/dataset-syncs", False),
    "workflows": ("workflows.yaml", "/workflows", "/workflows", True),
    "agents": ("agents.yaml", "/agents", "/agents", True),
    "skills": ("skills.yaml", "/skills", "/skills", True),
}
# All types we build id<->name maps for (to resolve cross-references).
REF_TYPES = ["connections", "providers", "knowledge", "guardrails", "agents", "skills", "workflows", "datasetSyncs"]
BASE = os.environ.get("OH_BASE", "https://openharness.faberiq.ai").rstrip("/")
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def _req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + "/api" + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Origin", BASE)
    with _opener.open(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def login():
    _req("POST", "/auth/login", {"email": os.environ["OH_EMAIL"], "password": os.environ["OH_PASSWORD"]})


def yaml_mod():
    import yaml  # pyyaml

    return yaml


def strip(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k not in SERVER_FIELDS}


def build_id_index():
    """id -> {type, name} across all referenceable resources."""
    idx = {}
    for t in REF_TYPES:
        for r in _req("GET", "/" + t) or []:
            rid = r.get("id") or r.get("_id")
            if rid:
                idx[rid] = {"type": t, "name": r.get("name") or rid}
    return idx


def to_refs(value, idx):
    if isinstance(value, str) and value in idx:
        return {"$ref": idx[value]}
    if isinstance(value, list):
        return [to_refs(v, idx) for v in value]
    if isinstance(value, dict):
        return {k: to_refs(v, idx) for k, v in value.items()}
    return value


def from_refs(value, name2id):
    if isinstance(value, dict) and set(value.keys()) == {"$ref"}:
        ref = value["$ref"]
        target = name2id.get(ref["type"], {}).get(ref["name"])
        if not target:
            raise SystemExit(f"Unresolved ref on target: {ref['type']}:{ref['name']} (create it first)")
        return target
    if isinstance(value, list):
        return [from_refs(v, name2id) for v in value]
    if isinstance(value, dict):
        return {k: from_refs(v, name2id) for k, v in value.items()}
    return value


def cmd_export(out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    idx = build_id_index()
    for t, (fname, list_path, _c, is_yaml) in EXPORT_TYPES.items():
        items = [to_refs(strip(r), idx) for r in (_req("GET", list_path) or [])]
        items.sort(key=lambda x: x.get("name", ""))
        path = out_dir / fname
        if is_yaml:
            path.write_text(yaml_mod().safe_dump(items, sort_keys=False, default_flow_style=False, width=100))
        else:
            path.write_text(json.dumps(items, indent=2))
        print(f"exported {len(items):>3} {t:<13} -> {path}")


def cmd_apply(out_dir: Path, dry_run: bool):
    # name -> id per type on the TARGET, for ref resolution + idempotent upsert.
    name2id = {}
    for t in REF_TYPES:
        name2id[t] = {r.get("name"): (r.get("id") or r.get("_id")) for r in (_req("GET", "/" + t) or [])}
    order = ["skills", "agents", "workflows", "datasetSyncs"]
    for t in order:
        fname, list_path, create_path, is_yaml = EXPORT_TYPES[t]
        path = out_dir / fname
        if not path.exists():
            continue
        items = yaml_mod().safe_load(path.read_text()) if is_yaml else json.loads(path.read_text())
        existing = name2id.get(t, {})
        created = updated = 0
        for item in items or []:
            resolved = from_refs(item, name2id)
            name = resolved.get("name")
            tid = existing.get(name)
            if dry_run:
                print(f"  [{'update' if tid else 'create'}] {t}: {name}")
                continue
            if tid:
                _req("PUT", f"{create_path}/{tid}", resolved); updated += 1
            else:
                _req("POST", create_path, resolved); created += 1
        if not dry_run:
            print(f"{t:<13} created {created}, updated {updated}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["export", "apply"])
    ap.add_argument("--dir", default=str(Path(__file__).parent / "exports"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    login()
    if args.command == "export":
        cmd_export(Path(args.dir))
    else:
        cmd_apply(Path(args.dir), args.dry_run)


if __name__ == "__main__":
    main()

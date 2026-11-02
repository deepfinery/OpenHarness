"""Config loader. All thresholds/universes/windows live in pipeline/config/*.yaml (spec §7)."""
from __future__ import annotations

import functools
import os
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("PIPELINE_CONFIG_DIR", Path(__file__).resolve().parent.parent / "config"))


@functools.lru_cache(maxsize=None)
def load(name: str) -> dict:
    import yaml

    path = CONFIG_DIR / name
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text()) or {}


def layer1_mapping() -> dict:
    return load("layer1_mapping.yaml")


def source(name: str) -> dict:
    """The Layer 1 mapping entry for a logical input."""
    return (layer1_mapping().get("collections", {}) or {}).get(name, {})

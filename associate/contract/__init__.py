"""The portable contract: what associate is allowed to do, and in what shape.

Small on purpose (spec claim c46). This package holds the values that stay the
same whichever harness runs the lane:

* ``role.json``   — the capability and forbidden-token lists, copied from
  lobes' role registry;
* ``policy.json`` — the permission boundary (read denylist, shell allowlist,
  per-tool budgets, result/fetch caps, walk redaction patterns);
* ``schemas/``    — JSON Schema documents for the task input, the walk, and the
  statements/hand-back.

What is **not** here: the runtime prompt, tool descriptions, result
presentation, context selection, compaction and stopping behaviour. Those are
harness-and-model-tailored and live with the Pi extension and ``AGENTS.md``.

An adapter reads these files rather than defining its own copy, so changing a
budget or a denylist pattern here changes adapter behaviour with no adapter
edit.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

__all__ = [
    "contract_dir",
    "schemas_dir",
    "load_role",
    "load_policy",
    "load_schema",
    "SCHEMA_NAMES",
    "walk_entry_schema",
    "walk_run_schema",
]

SCHEMA_NAMES: tuple[str, ...] = ("task", "walk", "statements")

#: Key under which a schema keeps its local subschema definitions.
DEFS_KEY = "$defs"


def contract_dir() -> Path:
    """Absolute path of the contract directory as installed."""
    return Path(__file__).resolve().parent


def schemas_dir() -> Path:
    """Absolute path of the contract's ``schemas/`` directory."""
    return contract_dir() / "schemas"


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=None)
def _cached(path: str) -> dict[str, Any]:
    return _load_json(Path(path))


def load_role() -> dict[str, Any]:
    """The role contract (``role.json``)."""
    return _cached(str(contract_dir() / "role.json"))


def load_policy() -> dict[str, Any]:
    """The permission boundary (``policy.json``)."""
    return _cached(str(contract_dir() / "policy.json"))


def load_schema(name: str) -> dict[str, Any]:
    """Load one contract schema by short name (``task``/``walk``/``statements``)."""
    if name not in SCHEMA_NAMES:
        raise KeyError(f"unknown contract schema {name!r}; available: {', '.join(SCHEMA_NAMES)}")
    return _cached(str(schemas_dir() / f"{name}.schema.json"))


def _walk_def(key: str) -> dict[str, Any]:
    """Return one ``$defs`` subschema of the walk, carrying the walk's ``$defs``.

    The walk lives on disk as JSONL, so callers validate a *line* at a time.
    The returned schema keeps the parent ``$defs`` so its local ``$ref``
    pointers still resolve.
    """
    walk = load_schema("walk")
    subschema = dict(walk[DEFS_KEY][key])
    subschema[DEFS_KEY] = walk[DEFS_KEY]
    return subschema


def walk_entry_schema() -> dict[str, Any]:
    """Schema for one walk.jsonl tool-call line."""
    return _walk_def("entry")


def walk_run_schema() -> dict[str, Any]:
    """Schema for the walk's final run record."""
    return _walk_def("run")

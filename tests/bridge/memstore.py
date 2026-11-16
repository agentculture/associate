"""A tiny in-memory store and audit recorder implementing the bridge's store protocol."""

from __future__ import annotations

import copy
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any


@dataclass
class Result:
    won: bool
    document: dict[str, Any] | None


class MemoryStore:
    def __init__(self) -> None:
        self.data: dict[str, dict[str, dict[str, Any]]] = {}

    def get(self, collection, id):
        doc = self.data.get(collection, {}).get(id)
        return copy.deepcopy(doc) if doc is not None else None

    def find(self, collection, where=None):
        docs = [copy.deepcopy(d) for d in self.data.get(collection, {}).values()]
        return [d for d in docs if all(d.get(k) == v for k, v in (where or {}).items())]

    def insert(self, collection, document):
        self.data.setdefault(collection, {})[document["id"]] = copy.deepcopy(dict(document))
        return copy.deepcopy(dict(document))

    def update_if(self, collection, id, expected, changes):
        doc = self.data.get(collection, {}).get(id)
        if doc is None or any(doc.get(k) != v for k, v in expected.items()):
            return Result(False, None)
        doc.update(copy.deepcopy(changes))
        return Result(True, copy.deepcopy(doc))

    @contextmanager
    def transaction(self):
        yield self


class Audit:
    """Records the entries the tokens module hands to its audit hook."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []

    def __call__(self, ops, **entry) -> None:
        self.entries.append(entry)

"""A file-backed store for the bridge's service tokens (``associate.bridge.tokens.TokenStore``).

One JSON file, ``{collection: {id: document}}``, written whole to a temporary file and renamed
into place (``0600``, directory ``0700``). A transaction holds an exclusive ``flock`` on a
sibling ``.lock`` file for its whole read-modify-write, so two processes issuing or revoking
at once never lose a write. Only token hashes are stored (``ServiceTokens`` never hands the
store a plaintext secret). Stdlib only.

This is the minimal implementation the runs API needs; a deployment that wants tokens in a
database supplies its own object with the same five methods.
"""

from __future__ import annotations

import copy
import fcntl
import os
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from associate.runs.state import atomic_write_json, read_json

__all__ = ["FileTokenStore", "default_token_path"]

Document = dict[str, Any]


def default_token_path() -> Path:
    """``ASSOCIATE_SERVER_TOKENS``, else ``$XDG_STATE_HOME/associate/service_tokens.json``."""
    explicit = os.environ.get("ASSOCIATE_SERVER_TOKENS", "").strip()
    if explicit:
        return Path(explicit)
    xdg = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg) if xdg and os.path.isabs(xdg) else Path.home() / ".local" / "state"
    return base / "associate" / "service_tokens.json"


@dataclass
class UpdateResult:
    won: bool
    document: Document | None


class _Ops:
    """The reads and writes of one transaction, over the loaded data."""

    def __init__(self, data: dict[str, dict[str, Document]]) -> None:
        self.data = data
        self.dirty = False

    def get(self, collection: str, id: str) -> Document | None:
        doc = self.data.get(collection, {}).get(id)
        return copy.deepcopy(doc) if doc is not None else None

    def find(self, collection: str, where: Mapping[str, Any] | None = None) -> list[Document]:
        docs = [copy.deepcopy(d) for d in self.data.get(collection, {}).values()]
        return [d for d in docs if all(d.get(k) == v for k, v in (where or {}).items())]

    def insert(self, collection: str, document: Mapping[str, Any]) -> Document:
        doc = copy.deepcopy(dict(document))
        docs = self.data.setdefault(collection, {})
        if doc["id"] in docs:
            raise ValueError(f"{collection} {doc['id']!r} already exists")
        docs[doc["id"]] = doc
        self.dirty = True
        return copy.deepcopy(doc)

    def update_if(
        self, collection: str, id: str, expected: Mapping[str, Any], changes: Mapping[str, Any]
    ) -> UpdateResult:
        doc = self.data.get(collection, {}).get(id)
        if doc is None or any(doc.get(k) != v for k, v in expected.items()):
            return UpdateResult(False, None)
        doc.update(copy.deepcopy(dict(changes)))
        self.dirty = True
        return UpdateResult(True, copy.deepcopy(doc))


class FileTokenStore:
    """``TokenStore`` over one JSON file."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)

    def _load(self) -> dict[str, dict[str, Document]]:
        data = read_json(self.path)
        if data is None:
            if self.path.exists():
                raise ValueError(f"the token store {self.path} is not valid JSON")
            return {}
        if not isinstance(data, dict):
            raise ValueError(f"the token store {self.path} is not a JSON object")
        return data

    def get(self, collection: str, id: str) -> Document | None:
        return _Ops(self._load()).get(collection, id)

    def find(self, collection: str, where: Mapping[str, Any] | None = None) -> list[Document]:
        return _Ops(self._load()).find(collection, where)

    def insert(self, collection: str, document: Mapping[str, Any]) -> Document:
        with self.transaction() as tx:
            return tx.insert(collection, document)

    def update_if(
        self, collection: str, id: str, expected: Mapping[str, Any], changes: Mapping[str, Any]
    ) -> UpdateResult:
        with self.transaction() as tx:
            return tx.update_if(collection, id, expected, changes)

    @contextmanager
    def transaction(self) -> Iterator[_Ops]:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path.with_name(self.path.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            ops = _Ops(self._load())
            yield ops
            if ops.dirty:
                atomic_write_json(self.path, ops.data)
        finally:
            os.close(fd)

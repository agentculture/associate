# Cited into this repo from qodo-cli qodo/bridge/filetokens.py @
#  9ac0a9c4f1d7a93507ccc15295f565123025e1e1
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: nothing in the code; this replaces the first-party FileTokenStore that lived in
#          associate/server/tokenstore.py (which imported runs.state), so the bridge folder holds
#          the one store and stays free of the app.
"""A file-backed :class:`~.tokens.TokenStore`: one JSON file, ``{collection: {id: document}}``.

The file is written whole to a temporary file in the same directory and renamed into place, so a
reader never sees half a write, with mode ``0600`` (the directory ``0700``): it holds token
hashes only (``ServiceTokens`` never hands a store a plaintext secret). A transaction holds an
exclusive ``flock`` on a sibling ``.lock`` file for its whole read-modify-write, so two processes
issuing or revoking at once lose nothing. Reads take no lock: the rename makes each read see one
whole version. A missing file is an empty store (and reading creates nothing); a file that is not
a JSON object is a ``ValueError``, never silently treated as empty. Standard library only.
"""

from __future__ import annotations

import copy
import fcntl
import json
import os
import tempfile
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = ["FileTokenStore"]

Document = dict[str, Any]


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
    """``TokenStore`` over one JSON file (``0600``), safe for several processes."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)

    def _load(self) -> dict[str, dict[str, Document]]:
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        try:
            data = json.loads(text)
        except ValueError:
            raise ValueError(f"the token store {self.path} is not valid JSON") from None
        if not isinstance(data, dict):
            raise ValueError(f"the token store {self.path} is not a JSON object")
        return data

    def _write(self, data: dict[str, dict[str, Document]]) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name + ".")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise

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
        lock = os.open(self.path.with_name(self.path.name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            ops = _Ops(self._load())
            yield ops
            if ops.dirty:
                self._write(ops.data)
        finally:
            os.close(lock)  # closing releases the lock

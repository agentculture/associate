"""The adapter interface — deliberately small (spec claim c47).

Three methods, one dict in and one dict out. The point is that a second
adapter can be written against this file alone; no universal harness framework
is built up front, and nothing here imports or knows about any particular
agent runtime.

Lifecycle::

    harness = get_harness("stub")()
    harness.start(checkout, contract_dir, session_id, export_dir)
    harness.submit(task)          # task validated against task.schema.json
    result = harness.collect()    # {"walk_path", "statements_path", "outcome"}

``collect()`` returns *paths*, not content: persistence is the harness's job
(c30), so the artifacts exist on disk whether or not the model ever wrote a
file.
"""

from __future__ import annotations

import abc
from pathlib import Path
from typing import Any, ClassVar

__all__ = ["Harness", "WALK_FILENAME", "STATEMENTS_FILENAME"]

WALK_FILENAME = "walk.jsonl"
STATEMENTS_FILENAME = "statements.json"


class Harness(abc.ABC):
    """One runtime an associate task can be executed on."""

    #: Registry key — the value accepted by ``--harness``.
    name: ClassVar[str] = "base"

    @abc.abstractmethod
    def start(
        self,
        checkout: Path,
        contract_dir: Path,
        session_id: str,
        export_dir: Path,
    ) -> None:
        """Open a session against *checkout*, bound to the contract in *contract_dir*.

        *export_dir* is created if missing and is where ``walk.jsonl`` and
        ``statements.json`` will be written; it is keyed by *session_id* by the
        caller so concurrent runs against one checkout never interleave.
        """

    @abc.abstractmethod
    def submit(self, task: dict[str, Any]) -> None:
        """Run one task. *task* must satisfy the contract's ``task.schema.json``."""

    @abc.abstractmethod
    def collect(self) -> dict[str, Any]:
        """Return the run's artifacts.

        Keys: ``walk_path`` and ``statements_path`` (strings), ``outcome``
        (one of the walk schema's run outcomes). An adapter that did not
        exercise a real model must also set ``plumbing_only`` to ``True``.
        """
